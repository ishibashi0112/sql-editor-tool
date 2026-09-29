import { describe, expect, test } from "vitest";
import {
  completionContext,
  completionIdentifier,
  splitStatements,
  sqlKeywords,
  sqlOutline,
  statementAt,
  tableReferences,
} from "./completion";
import { mssql, oracle } from "./dialect";

/** | の位置をカーソルにして文脈を判定する */
const at = (text: string, dialect = mssql) =>
  completionContext(dialect, text.replace("|", ""), text.indexOf("|"));
const refs = (text: string, dialect = mssql) =>
  tableReferences(dialect, text.replace("|", ""), text.indexOf("|"));

// 例の表名・列名は架空
describe("completionContext", () => {
  test("「テーブル.」の後は、その名前の列", () => {
    expect(at("SELECT test11111.|")).toEqual({
      kind: "member",
      path: ["test11111"],
      prefix: "",
      afterFrom: false,
    });
    expect(at("SELECT test11111.co|")).toMatchObject({
      kind: "member",
      path: ["test11111"],
      prefix: "co",
    });
    expect(at("SELECT j.受注日, j.| FROM 受注 j")).toMatchObject({
      kind: "member",
      path: ["j"],
    });
  });

  test("「スキーマ.テーブル.」と、引用符で囲んだ名前", () => {
    expect(at("SELECT dbo.受注.|")).toMatchObject({ path: ["dbo", "受注"] });
    expect(at("SELECT [受注 明細].|")).toMatchObject({
      path: ["受注 明細"],
    });
    expect(at('SELECT "受注".|', oracle)).toMatchObject({ path: ["受注"] });
  });

  test("FROM・JOIN の後はテーブル名。FROM の後の「スキーマ.」は afterFrom", () => {
    expect(at("SELECT * FROM |")).toEqual({ kind: "table", prefix: "" });
    expect(at("SELECT * FROM 受|")).toEqual({ kind: "table", prefix: "受" });
    expect(at("SELECT * FROM 受注 j INNER JOIN |")).toMatchObject({
      kind: "table",
    });
    expect(at("SELECT * FROM 受注 j, |")).toMatchObject({ kind: "table" });
    expect(at("SELECT * FROM dbo.|")).toEqual({
      kind: "member",
      path: ["dbo"],
      prefix: "",
      afterFrom: true,
    });
  });

  test("UPDATE・INSERT INTO・DELETE の後もテーブル名（FOR UPDATE などは除く）", () => {
    expect(at("UPDATE |")).toEqual({ kind: "table", prefix: "" });
    expect(at("INSERT INTO 受|")).toEqual({ kind: "table", prefix: "受" });
    expect(at("DELETE |", oracle)).toMatchObject({ kind: "table" });
    expect(at("MERGE INTO |")).toMatchObject({ kind: "table" });
    expect(at("SELECT * FROM 受注 FOR UPDATE |", oracle)).toMatchObject({
      kind: "general",
    });
  });

  test("それ以外はキーワード（打ちかけの語を prefix に）", () => {
    expect(at("SELECT * FROM 受注 WHERE 数量 > 1 OR|")).toEqual({
      kind: "general",
      prefix: "OR",
    });
    expect(at("SELECT a, |")).toEqual({ kind: "general", prefix: "" });
    // 数値の . は名前の区切りではない
    expect(at("SELECT 1.|")).toMatchObject({ kind: "general" });
  });

  test("文字列・コメントの中では補完しない（閉じていないものも）", () => {
    expect(at("SELECT * FROM t WHERE a = 'test.|")).toEqual({ kind: "none" });
    expect(at("SELECT * FROM t WHERE a = 'x' AND b = N'受注.|'")).toEqual({
      kind: "none",
    });
    expect(at("-- test11111.|\nSELECT 1")).toEqual({ kind: "none" });
    expect(at("/* test11111.|")).toEqual({ kind: "none" });
    expect(at("/* x */ SELECT test11111.|")).toMatchObject({
      kind: "member",
    });
    expect(at("SELECT * FROM t WHERE a = 'x' AND test11111.|")).toMatchObject({
      kind: "member",
    });
  });

  test("書きかけ（閉じていない括弧）でも判定できる", () => {
    expect(at("SELECT * FROM (SELECT x.|")).toMatchObject({
      kind: "member",
      path: ["x"],
    });
    expect(at("SELECT COUNT(|")).toMatchObject({ kind: "general" });
  });
});

describe("tableReferences", () => {
  test("FROM・JOIN のテーブルと別名（AS はあってもなくてもよい）", () => {
    expect(
      refs(`SELECT j.| FROM dbo.受注 AS j
INNER JOIN 得意先 t ON t.得意先コード = j.得意先コード
LEFT JOIN [受注 明細] m ON m.受注番号 = j.受注番号
WHERE j.受注日 >= '20260901'`),
    ).toEqual([
      { schema: "dbo", name: "受注", alias: "j", cte: false },
      { schema: null, name: "得意先", alias: "t", cte: false },
      { schema: null, name: "受注 明細", alias: "m", cte: false },
    ]);
  });

  test("FROM のカンマの並び、別名なし、テーブルのヒントは別名にしない", () => {
    expect(
      refs("SELECT | FROM 受注 j WITH (NOLOCK), 得意先, 品目 WHERE 1 = 1"),
    ).toEqual([
      { schema: null, name: "受注", alias: "j", cte: false },
      { schema: null, name: "得意先", alias: null, cte: false },
      { schema: null, name: "品目", alias: null, cte: false },
    ]);
    expect(refs("SELECT | FROM 受注 WHERE 1 = 1")).toEqual([
      { schema: null, name: "受注", alias: null, cte: false },
    ]);
  });

  test("派生テーブルと WITH の名前は、列が分からないものとして返す", () => {
    expect(
      refs(`WITH w AS (SELECT * FROM 受注)
SELECT | FROM w JOIN (SELECT * FROM 得意先) s ON 1 = 1`),
    ).toEqual([
      { schema: null, name: "受注", alias: null, cte: false },
      { schema: null, name: "w", alias: null, cte: true },
      { schema: null, name: "得意先", alias: null, cte: false },
      { schema: null, name: null, alias: "s", cte: false },
    ]);
  });

  test("カーソルのある文だけを見る（; と GO の行で区切る）", () => {
    const text = `SELECT * FROM 受注 a;
SELECT a.| FROM 得意先 a
GO
SELECT * FROM 品目 a`;
    expect(refs(text)).toEqual([
      { schema: null, name: "得意先", alias: "a", cte: false },
    ]);
  });

  test("UPDATE・INSERT INTO・DELETE の表（INSERT の ( は列の並び）", () => {
    expect(refs("UPDATE dbo.受注 SET 数量 = | WHERE 番号 = 1")).toEqual([
      { schema: "dbo", name: "受注", alias: null, cte: false },
    ]);
    expect(refs("INSERT INTO 受注 (番号, |) VALUES (1, 2)")).toEqual([
      { schema: null, name: "受注", alias: null, cte: false },
    ]);
    expect(refs("DELETE 受注 WHERE 番号 = |", oracle)).toEqual([
      { schema: null, name: "受注", alias: null, cte: false },
    ]);
    expect(refs("DELETE FROM 受注 WHERE 番号 = |")).toEqual([
      { schema: null, name: "受注", alias: null, cte: false },
    ]);
    // SQL Server の UPDATE 別名 … FROM 表 別名、DELETE 別名 FROM 表 別名 は、FROM の表だけ
    expect(
      refs("UPDATE j SET 数量 = | FROM 受注 j JOIN 得意先 t ON t.a = j.a"),
    ).toEqual([
      { schema: null, name: "受注", alias: "j", cte: false },
      { schema: null, name: "得意先", alias: "t", cte: false },
    ]);
    expect(refs("DELETE j FROM 受注 j WHERE j.| = 1")).toEqual([
      { schema: null, name: "受注", alias: "j", cte: false },
    ]);
    // SELECT … FOR UPDATE の UPDATE の後は表ではない
    expect(refs("SELECT | FROM 受注 FOR UPDATE OF 数量", oracle)).toEqual([
      { schema: null, name: "受注", alias: null, cte: false },
    ]);
  });

  test("Oracle の引用符つきの名前", () => {
    expect(refs('SELECT x.| FROM "APP"."受注" x', oracle)).toEqual([
      { schema: "APP", name: "受注", alias: "x", cte: false },
    ]);
  });
});

describe("completionIdentifier", () => {
  test("そのまま書ける名前は囲まない。予約語や空白を含む名前は囲む", () => {
    expect(completionIdentifier(mssql, "受注日")).toBe("受注日");
    expect(completionIdentifier(mssql, "ORDER_NO")).toBe("ORDER_NO");
    expect(completionIdentifier(mssql, "ORDER")).toBe("[ORDER]");
    expect(completionIdentifier(mssql, "受注 明細")).toBe("[受注 明細]");
    expect(completionIdentifier(mssql, "1月")).toBe("[1月]");
  });

  test("Oracle は小文字を含む名前を囲む（引用符なしでは大文字になるため）", () => {
    expect(completionIdentifier(oracle, "ORDERS")).toBe("ORDERS");
    expect(completionIdentifier(oracle, "orders")).toBe('"orders"');
    expect(completionIdentifier(oracle, "受注")).toBe("受注");
  });
});

describe("sqlKeywords", () => {
  test("方言ごとの語を足す", () => {
    expect(sqlKeywords(mssql)).toContain("TOP");
    expect(sqlKeywords(mssql)).not.toContain("NVL");
    expect(sqlKeywords(oracle)).toContain("NVL");
    expect(sqlKeywords(oracle)).toContain("SELECT");
  });
});

/** 文の本文の一覧 */
const statements = (text: string, dialect = mssql) =>
  splitStatements(dialect, text).map((s) => text.slice(s.start, s.end));

describe("splitStatements", () => {
  test("; と、SQL Server の GO だけの行で分ける。空の文とコメントだけの文は除く", () => {
    expect(
      statements(`-- 受注
SELECT * FROM 受注;
;
SELECT 'a;b' FROM 得意先 -- ; はコメント
GO
/* 品目 */
SELECT * FROM 品目`),
    ).toEqual([
      "SELECT * FROM 受注",
      "SELECT 'a;b' FROM 得意先",
      "SELECT * FROM 品目",
    ]);
  });

  test("Oracle は / だけの行でも分ける（割り算の / では分けない）", () => {
    expect(
      statements("SELECT 数量 / 2 FROM 受注\n/\nSELECT * FROM 得意先", oracle),
    ).toEqual(["SELECT 数量 / 2 FROM 受注", "SELECT * FROM 得意先"]);
    // q'[...]' の中の ' で文字列が終わったとみなさない
    expect(
      statements(
        "SELECT q'[it's; ok]' FROM dual\n/\nSELECT 1 FROM dual",
        oracle,
      ),
    ).toEqual(["SELECT q'[it's; ok]' FROM dual", "SELECT 1 FROM dual"]);
  });

  test("; なしで並べた問い合わせも分ける", () => {
    expect(
      statements(`SELECT * FROM 受注 WHERE 区分 IN ('1', '2')

SELECT * FROM 得意先
WITH w AS (SELECT 1 AS x) SELECT * FROM w`),
    ).toEqual([
      "SELECT * FROM 受注 WHERE 区分 IN ('1', '2')",
      "SELECT * FROM 得意先",
      "WITH w AS (SELECT 1 AS x) SELECT * FROM w",
    ]);
  });

  test("1 つの問い合わせの中の SELECT では分けない", () => {
    const one = [
      "SELECT a FROM x\nUNION ALL\n\nSELECT a FROM y",
      "SELECT a FROM x UNION SELECT a FROM y EXCEPT SELECT a FROM z",
      "WITH w AS (SELECT 1 AS x),\nv (y) AS (SELECT 2)\n\nSELECT * FROM w, v",
      "SELECT * FROM (SELECT 1 AS a) t WHERE EXISTS (SELECT 1 FROM y)",
      "SELECT * FROM 受注 j WITH (NOLOCK)",
      "SELECT TOP (5) WITH TIES * FROM 受注 ORDER BY 数量",
      "SELECT * FROM 組織 START WITH 親 IS NULL CONNECT BY PRIOR コード = 親",
    ];
    for (const text of one) {
      expect(statements(text, oracle)).toEqual([text]);
      expect(statements(text)).toEqual([text]);
    }
  });

  test("; なしで並べた INSERT・UPDATE・DELETE も分ける（SQL の生成、D-49）", () => {
    expect(
      statements(`SELECT * FROM 受注 ORDER BY 番号
INSERT INTO 受注 (番号, 数量) VALUES (:番号, :数量)
SELECT * FROM 得意先
UPDATE 受注 SET 数量 = :数量 WHERE 番号 = :番号
DELETE FROM 受注 WHERE 番号 = :番号
SELECT 1
WITH w AS (SELECT 1 AS x) SELECT * FROM w`),
    ).toEqual([
      "SELECT * FROM 受注 ORDER BY 番号",
      "INSERT INTO 受注 (番号, 数量) VALUES (:番号, :数量)",
      "SELECT * FROM 得意先",
      "UPDATE 受注 SET 数量 = :数量 WHERE 番号 = :番号",
      "DELETE FROM 受注 WHERE 番号 = :番号",
      "SELECT 1",
      "WITH w AS (SELECT 1 AS x) SELECT * FROM w",
    ]);
    // WITH の本体が書き込み（SQL Server）でも、その後の文は分ける
    expect(
      statements(
        "WITH w AS (SELECT 1 AS x) UPDATE t SET a = 1 FROM w\nSELECT * FROM t",
      ),
    ).toEqual([
      "WITH w AS (SELECT 1 AS x) UPDATE t SET a = 1 FROM w",
      "SELECT * FROM t",
    ]);
  });

  test("1 つの文の中の INSERT・UPDATE・DELETE・SELECT では分けない", () => {
    const one = [
      "INSERT INTO x (a)\nSELECT a FROM y",
      "INSERT INTO x (a)\nSELECT a FROM y UNION ALL SELECT a FROM z",
      "INSERT INTO x WITH w AS (SELECT 1 AS a) SELECT a FROM w",
      "WITH w AS (SELECT 1 AS a) INSERT INTO x SELECT a FROM w",
      "INSERT ALL INTO x VALUES (1) INTO y VALUES (2) SELECT * FROM dual",
      "SELECT * FROM 受注 WHERE 番号 = 1 FOR UPDATE",
      "SELECT * FROM 受注 FOR UPDATE OF 数量 NOWAIT",
      "UPDATE t SET a = (SELECT MAX(a) FROM u) WHERE b IN (SELECT b FROM v)",
      "DELETE FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.a = t.a)",
      "MERGE INTO t USING u ON (t.a = u.a)\nWHEN MATCHED THEN UPDATE SET t.b = u.b\nWHEN NOT MATCHED THEN INSERT (a, b) VALUES (u.a, u.b)",
    ];
    for (const text of one) {
      expect(statements(text, oracle)).toEqual([text]);
      expect(statements(text)).toEqual([text]);
    }
  });

  test("書きかけ（閉じていない括弧・文字列）でも例外にしない", () => {
    expect(statements("SELECT * FROM (SELECT")).toEqual([
      "SELECT * FROM (SELECT",
    ]);
    expect(statements("SELECT 'abc")).toEqual(["SELECT"]);
  });
});

describe("statementAt", () => {
  const text = "SELECT 1;\n\nSELECT 2\n\n-- 次\nSELECT 3";
  const list = splitStatements(mssql, text);
  const at = (offset: number) => {
    const s = statementAt(list, offset);
    return s ? text.slice(s.start, s.end) : null;
  };
  test("文の中か、文の後ろ（次の文の前まで）ならその文", () => {
    expect(at(0)).toBe("SELECT 1");
    expect(at(text.indexOf("1;") + 1)).toBe("SELECT 1");
    expect(at(text.indexOf("1;") + 2)).toBe("SELECT 1");
    expect(at(text.indexOf("SELECT 2") + 3)).toBe("SELECT 2");
    expect(at(text.indexOf("-- 次"))).toBe("SELECT 2");
    expect(at(text.length)).toBe("SELECT 3");
  });

  test("文がなければ undefined。最初の文より前なら最初の文", () => {
    expect(statementAt([], 0)).toBeUndefined();
    expect(statementAt(splitStatements(mssql, "  SELECT 1"), 0)).toEqual({
      start: 2,
      end: 10,
    });
  });
});

describe("sqlOutline", () => {
  const names = (text: string, dialect = mssql) =>
    sqlOutline(dialect, text).names.map((n) => ({
      parts: n.parts.map((p) => p.name).join("."),
      table: n.table,
      statement: n.statement,
      alias: n.alias,
    }));

  test("テーブル名と列の名前を、文ごとに返す（キーワード・別名の定義・関数は除く）", () => {
    const text = `SELECT j.受注番号, 数量 AS 数, COUNT(*) AS 件数, dbo.fn(j.区分)
FROM dbo.受注 AS j
JOIN 得意先 t ON t.得意先コード = j.得意先コード
WHERE j.受注日 >= :開始日 AND @x = 1;
SELECT 品目名 名前 FROM 品目`;
    expect(names(text)).toEqual([
      { parts: "j.受注番号", table: false, statement: 0, alias: null },
      { parts: "数量", table: false, statement: 0, alias: "数" },
      { parts: "j.区分", table: false, statement: 0, alias: null },
      { parts: "dbo.受注", table: true, statement: 0, alias: "j" },
      { parts: "得意先", table: true, statement: 0, alias: "t" },
      { parts: "t.得意先コード", table: false, statement: 0, alias: null },
      { parts: "j.得意先コード", table: false, statement: 0, alias: null },
      { parts: "j.受注日", table: false, statement: 0, alias: null },
      { parts: "品目名", table: false, statement: 1, alias: "名前" },
      { parts: "品目", table: true, statement: 1, alias: null },
    ]);
    const outline = sqlOutline(mssql, text);
    expect(outline.statements.map((s) => s.tables)).toEqual([
      [
        { schema: "dbo", name: "受注", alias: "j", cte: false },
        { schema: null, name: "得意先", alias: "t", cte: false },
      ],
      [{ schema: null, name: "品目", alias: null, cte: false }],
    ]);
  });

  test("名前の位置は引用符も含めた字句の位置。WITH の名前は列として扱わない", () => {
    const text =
      'WITH w AS (SELECT "受注日" FROM "受注") SELECT w."受注日" FROM w';
    const outline = sqlOutline(oracle, text);
    const quoted = outline.names[0]?.parts[0];
    expect(quoted?.name).toBe("受注日");
    expect(text.slice(quoted?.start, quoted?.end)).toBe('"受注日"');
    expect(names(text, oracle)).toEqual([
      { parts: "受注日", table: false, statement: 0, alias: null },
      { parts: "受注", table: true, statement: 0, alias: null },
      { parts: "w.受注日", table: false, statement: 0, alias: null },
      { parts: "w", table: true, statement: 0, alias: null },
    ]);
  });

  test("文字列・コメントの中の名前は含めない", () => {
    expect(
      names("SELECT '受注.数量' /* 得意先.名前 */ FROM 受注 -- 品目"),
    ).toEqual([{ parts: "受注", table: true, statement: 0, alias: null }]);
  });
});
