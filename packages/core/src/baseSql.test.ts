import { describe, expect, test } from "vitest";
import { checkBaseColumns } from "./baseSql";
import type { DialectName } from "./dialect";
import { mssql, oracle } from "./dialect";
import type { ColumnFilterValue } from "./filter";
import { buildFilterOptionsQuery } from "./filterOptions";
import { buildSelect } from "./select";
import { columns } from "./testColumns";

const filters: Record<string, ColumnFilterValue> = {
  QTY: {
    kind: "number",
    raw: "",
    parsed: { mode: "comparison", operator: ">", value: 0 },
  },
};

function select(dialect: DialectName, baseSql: string) {
  return buildSelect({
    dialect,
    source: { kind: "baseSql", sql: baseSql },
    columns,
    filters,
    limit: 101,
  });
}

/** 組み立てられるか（エラーならそのメッセージ） */
function tryBase(dialect: DialectName, baseSql: string): string {
  try {
    select(dialect, baseSql);
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const base =
  "SELECT o.*, c.CUST_NAME\nFROM APP.ORDERS o\nJOIN APP.CUSTOMERS c ON c.CUST_CD = o.CUST_CD";

describe("ベースSQL を包む", () => {
  test("SQL Server：派生テーブルにして、外側で条件と件数制限をかける", () => {
    const q = select("mssql", base);
    expect(q.sql).toBe(
      [
        "SELECT TOP (@p1) *",
        "FROM (",
        base,
        ") base_query",
        "WHERE [QTY] > @p2",
      ].join("\n"),
    );
    expect(q.literalSql.split("\n")[0]).toBe("SELECT TOP (101) *");
  });

  test("Oracle：別名に AS を付けない", () => {
    const q = select("oracle", base);
    expect(q.sql).toBe(
      [
        "SELECT *",
        "FROM (",
        base,
        ") base_query",
        'WHERE "QTY" > :p1',
        "FETCH FIRST :p2 ROWS ONLY",
      ].join("\n"),
    );
  });

  test("末尾のセミコロンと空白は取り除く", () => {
    expect(select("oracle", "SELECT * FROM T ;; \n").sql).toContain(
      "FROM (\nSELECT * FROM T\n) base_query",
    );
  });

  test("末尾の行コメントがあっても閉じ括弧は次の行に出る", () => {
    expect(select("mssql", "SELECT * FROM T -- 備考").sql).toContain(
      "SELECT * FROM T -- 備考\n) base_query",
    );
  });

  test("SQL Server：WITH 句は外側の SELECT の前に出す", () => {
    const withSql = [
      "WITH a (X, Y) AS (SELECT 1, 2),",
      '  [b c] AS (SELECT * FROM a WHERE X IN (SELECT 1)), "d" AS (SELECT 3 AS Z)',
      "SELECT * FROM a CROSS JOIN [b c]",
    ].join("\n");
    const q = select("mssql", withSql);
    expect(q.sql).toBe(
      [
        "WITH a (X, Y) AS (SELECT 1, 2),",
        '  [b c] AS (SELECT * FROM a WHERE X IN (SELECT 1)), "d" AS (SELECT 3 AS Z)',
        "SELECT TOP (@p1) *",
        "FROM (",
        "SELECT * FROM a CROSS JOIN [b c]",
        ") base_query",
        "WHERE [QTY] > @p2",
      ].join("\n"),
    );
  });

  test("Oracle：WITH 句は派生テーブルの中に書ける", () => {
    const withSql = "WITH a AS (SELECT 1 X FROM DUAL)\nSELECT * FROM a";
    expect(select("oracle", withSql).sql).toContain(
      `FROM (\n${withSql}\n) base_query`,
    );
  });

  test("集合フィルタの候補値もベースSQL から取る", () => {
    const q = buildFilterOptionsQuery({
      dialect: "mssql",
      source: {
        kind: "baseSql",
        sql: "WITH a AS (SELECT 1 X) SELECT * FROM a",
      },
      columns,
      columnKey: "CUST_CD",
      limit: 10,
    });
    expect(q.sql).toBe(
      [
        "WITH a AS (SELECT 1 X)",
        "SELECT DISTINCT TOP (@p1) [CUST_CD] AS [OPTION_VALUE]",
        "FROM (",
        "SELECT * FROM a",
        ") base_query",
        "ORDER BY [OPTION_VALUE]",
      ].join("\n"),
    );
  });
});

describe("ベースSQL の検査", () => {
  test("空は不可", () => {
    for (const text of ["", "  ", ";", "-- コメントだけ", "/* */"]) {
      expect(tryBase("mssql", text)).toContain("空です");
    }
  });

  test("SELECT か WITH で始まる文だけ", () => {
    for (const text of [
      "UPDATE T SET A = 1",
      "DELETE FROM T",
      "EXEC sp_who",
      "(SELECT 1)",
    ]) {
      expect(tryBase("mssql", text)).toContain("SELECT か WITH");
    }
    expect(tryBase("oracle", "select 1 from dual")).toBe("ok");
  });

  test("複数の文は不可。文字列・コメント・名前の中のセミコロンは区切りではない", () => {
    expect(tryBase("mssql", "SELECT 1; DELETE FROM T")).toContain("1 つだけ");
    expect(tryBase("mssql", "SELECT 1;\nSELECT 2;")).toContain("1 つだけ");
    expect(tryBase("mssql", "SELECT ';' AS [a;b] -- ;x\n/* ; */")).toBe("ok");
    expect(tryBase("oracle", `SELECT ';' AS "a;b" FROM DUAL`)).toBe("ok");
  });

  test("SQL Server：WITH の後に SELECT 以外の文は不可", () => {
    expect(tryBase("mssql", "WITH a AS (SELECT 1 X) DELETE FROM T")).toContain(
      "WITH 句の後は SELECT",
    );
    expect(
      tryBase("mssql", "WITH a AS (SELECT 1 X) INSERT INTO T SELECT * FROM a"),
    ).toContain("WITH 句の後は SELECT");
    // セミコロンなしで文を続けて、外に出す WITH 句に別の文を紛れ込ませる
    expect(
      tryBase(
        "mssql",
        "WITH a AS (SELECT 1 X) DELETE FROM T WHERE A IN (1) SELECT * FROM a",
      ),
    ).toContain("WITH 句の後は SELECT");
    expect(
      tryBase("mssql", "WITH XMLNAMESPACES ('u' AS x) SELECT 1 A"),
    ).toContain("WITH 句を解釈できません");
  });

  test("SELECT ... INTO と FOR UPDATE は不可", () => {
    expect(tryBase("mssql", "SELECT * INTO #tmp FROM T")).toContain("INTO");
    expect(tryBase("oracle", "SELECT * FROM T FOR UPDATE")).toContain(
      "FOR UPDATE",
    );
    expect(tryBase("oracle", "SELECT * FROM T for update nowait")).toContain(
      "FOR UPDATE",
    );
  });

  test("バインド変数は不可", () => {
    expect(tryBase("mssql", "SELECT * FROM T WHERE A = @a")).toContain("@a");
    expect(tryBase("oracle", "SELECT * FROM T WHERE A = :a")).toContain(":a");
    expect(tryBase("oracle", "SELECT * FROM T WHERE A = :1")).toContain(":1");
    // 変数ではないもの
    expect(tryBase("mssql", "SELECT @@ROWCOUNT AS N, '@a' AS S")).toBe("ok");
    expect(
      tryBase("oracle", "SELECT TO_CHAR(SYSDATE, 'HH24:MI') AS T FROM DUAL"),
    ).toBe("ok");
    expect(tryBase("oracle", "SELECT q'[it's :a]' AS S FROM DUAL")).toBe("ok");
    expect(tryBase("oracle", "SELECT nq'{:a}' AS S FROM DUAL")).toBe("ok");
    expect(tryBase("mssql", "SELECT N'@a' AS S")).toBe("ok");
  });

  test("SQL Server：最上位の ORDER BY は TOP か OFFSET があるときだけ", () => {
    expect(tryBase("mssql", "SELECT * FROM T ORDER BY A")).toContain(
      "ORDER BY は外して",
    );
    expect(tryBase("mssql", "SELECT TOP 10 * FROM T ORDER BY A")).toBe("ok");
    expect(
      tryBase("mssql", "SELECT DISTINCT TOP (5) A FROM T ORDER BY A"),
    ).toBe("ok");
    expect(tryBase("mssql", "SELECT * FROM T ORDER BY A OFFSET 0 ROWS")).toBe(
      "ok",
    );
    expect(
      tryBase("mssql", "SELECT ROW_NUMBER() OVER (ORDER BY A) AS N FROM T"),
    ).toBe("ok");
    expect(
      tryBase(
        "mssql",
        "WITH a AS (SELECT TOP 1 A FROM T ORDER BY A) SELECT * FROM a",
      ),
    ).toBe("ok");
    // Oracle は派生テーブルに ORDER BY を書ける
    expect(tryBase("oracle", "SELECT * FROM T ORDER BY A")).toBe("ok");
  });

  test("コメントと名前の中の記号は構文と取り違えない", () => {
    // SQL Server のブロックコメントは入れ子にできる
    expect(tryBase("mssql", "SELECT 1 A /* 外 /* 内 */ ) */")).toBe("ok");
    expect(tryBase("mssql", "SELECT 1 AS [a]](]")).toBe("ok");
    expect(tryBase("oracle", `SELECT 1 AS "a""(" FROM DUAL`)).toBe("ok");
  });

  test("閉じていない括弧・文字列・コメントは不可", () => {
    expect(tryBase("mssql", "SELECT (1 A")).toContain("括弧");
    expect(tryBase("mssql", "SELECT 1) A")).toContain("括弧");
    expect(tryBase("mssql", "SELECT 'abc")).toContain("文字列が閉じて");
    expect(tryBase("mssql", "SELECT 1 /* abc")).toContain("コメントが閉じて");
    expect(tryBase("mssql", "SELECT [abc")).toContain("閉じていません");
    expect(tryBase("oracle", "SELECT q'[abc' FROM DUAL")).toContain(
      "文字列が閉じて",
    );
  });
});

describe("checkBaseColumns", () => {
  test("重複も名前のない列もなければ何もしない", () => {
    expect(() => checkBaseColumns(mssql, ["A", "B"])).not.toThrow();
  });

  test("名前のない列", () => {
    expect(() => checkBaseColumns(mssql, ["A", null, ""])).toThrow(
      "2、3 列目に名前がありません",
    );
  });

  test("SQL Server は大文字小文字を区別せずに重複を探す", () => {
    expect(() => checkBaseColumns(mssql, ["ID", "Name", "id", "ID"])).toThrow(
      "列名「ID」が重複",
    );
  });

  test("Oracle は大文字小文字を区別する（引用符つきの名前）", () => {
    expect(() => checkBaseColumns(oracle, ["ID", "id"])).not.toThrow();
    expect(() => checkBaseColumns(oracle, ["ID", "X", "ID", "X"])).toThrow(
      "「ID」、「X」",
    );
  });
});
