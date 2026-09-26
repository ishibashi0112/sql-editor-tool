import { describe, expect, test } from "vitest";
import {
  parseReportConfig,
  type ReportConfig,
  reportParams,
  writeReportConfig,
} from "./report";
import { buildReportQuery, buildSelect } from "./select";

// 例の表名・列名は架空
const SQL = `SELECT * FROM 受注
WHERE 受注日 >= :開始日
  AND (:得意先 IS NULL OR 得意先コード = :得意先)`;

const config: ReportConfig = {
  params: {
    開始日: { label: "受注日（から）", type: "ymd" },
    得意先: { type: "text", required: false },
  },
};

describe("reportParams", () => {
  test(":名前 を初めに出てきた順に、重複なしで返す。設定がなければ既定値", () => {
    expect(reportParams("mssql", SQL, config)).toEqual([
      {
        name: "開始日",
        label: "受注日（から）",
        type: "ymd",
        required: true,
        default: "",
      },
      {
        name: "得意先",
        label: "得意先",
        type: "text",
        required: false,
        default: "",
      },
    ]);
  });

  test("文字列・コメント・引用符つきの名前・:: の中はパラメータではない", () => {
    const text = `/* :a */ SELECT ':b', "c:d", [e:f], x::text, TO_CHAR(d, 'HH24:MI') -- :g
FROM t WHERE y = :本物`;
    expect(reportParams("mssql", text, {}).map((p) => p.name)).toEqual([
      "本物",
    ]);
    expect(
      reportParams("oracle", text.replace("[e:f]", "1"), {}).map((p) => p.name),
    ).toEqual(["本物"]);
  });
});

describe("buildReportQuery", () => {
  test("SQL Server：:名前 をバインド変数にする。同じ名前は同じ値", () => {
    const q = buildReportQuery({
      dialect: "mssql",
      sql: SQL,
      config,
      values: { 開始日: "2026-09-01", 得意先: "C001" },
    });
    expect(q.sql).toBe(`SELECT * FROM 受注
WHERE 受注日 >= @p1
  AND (@p2 IS NULL OR 得意先コード = @p3)`);
    expect(q.params).toEqual([
      {
        name: "p1",
        value: "20260901",
        type: { kind: "string", unicode: false },
      },
      { name: "p2", value: "C001", type: { kind: "string", unicode: true } },
      { name: "p3", value: "C001", type: { kind: "string", unicode: true } },
    ]);
    expect(q.literalSql).toContain("受注日 >= '20260901'");
    expect(q.literalSql).toContain("(N'C001' IS NULL OR");
  });

  test("必須でない空欄は NULL を渡す", () => {
    const q = buildReportQuery({
      dialect: "oracle",
      sql: SQL,
      config,
      values: { 開始日: "20260901", 得意先: "  " },
    });
    expect(q.sql).toContain("(:p2 IS NULL OR 得意先コード = :p3)");
    expect(q.params[1]?.value).toBeNull();
    expect(q.literalSql).toContain("(NULL IS NULL OR");
  });

  test("必須の空欄と、形の違う値はエラー", () => {
    const build = (values: Record<string, string>) =>
      buildReportQuery({ dialect: "mssql", sql: SQL, config, values });
    expect(() => build({})).toThrow("「受注日（から）」を入力してください");
    expect(() => build({ 開始日: "2026-02-30" })).toThrow("日付ではありません");
    expect(() =>
      buildReportQuery({
        dialect: "mssql",
        sql: "SELECT * FROM t WHERE n = :n",
        config: { params: { n: { type: "number" } } },
        values: { n: "abc" },
      }),
    ).toThrow("数値ではありません");
  });

  test("日付は方言の日付型にして渡す。数値の桁区切りは除く", () => {
    const text = "SELECT * FROM t WHERE d >= :d AND n = :n";
    const cfg: ReportConfig = {
      params: { d: { type: "date" }, n: { type: "number" } },
    };
    const values = { d: "2026/9/1", n: "1,234.5" };
    const mssql = buildReportQuery({
      dialect: "mssql",
      sql: text,
      config: cfg,
      values,
    });
    expect(mssql.sql).toBe(
      "SELECT * FROM t WHERE d >= CONVERT(date, @p1, 112) AND n = @p2",
    );
    expect(mssql.params[1]).toEqual({
      name: "p2",
      value: "1234.5",
      type: { kind: "number" },
    });
    const oracle = buildReportQuery({
      dialect: "oracle",
      sql: text,
      config: cfg,
      values,
    });
    expect(oracle.sql).toBe(
      "SELECT * FROM t WHERE d >= TO_DATE(:p1, 'YYYYMMDD') AND n = :p2",
    );
  });

  test("そのまま実行するので ORDER BY はそのまま。先頭の設定のコメントと末尾のセミコロンは除く", () => {
    const text = `/* @report
{ "params": { "x": { "required": false } } }
*/
SELECT * FROM t WHERE a = :x ORDER BY a;
`;
    const q = buildReportQuery({
      dialect: "mssql",
      sql: text,
      config: parseReportConfig(text).config,
      values: {},
    });
    expect(q.sql).toBe("SELECT * FROM t WHERE a = @p1 ORDER BY a");
  });

  test(":名前 以外のバインド変数と、読み取り専用でない文は使えない", () => {
    const build = (text: string) =>
      buildReportQuery({ dialect: "mssql", sql: text, config: {}, values: {} });
    expect(() => build("SELECT * FROM t WHERE a = @a")).toThrow(
      "「:名前」の形で書いてください",
    );
    expect(() => build("DELETE FROM t")).toThrow("SELECT か WITH");
    expect(() => build("SELECT * INTO w FROM t")).toThrow("INTO");
  });
});

describe("レポートの SQL を包んで、画面の絞り込みで取り直す", () => {
  test("SQL Server：ORDER BY を取り除き、WITH 句は外に出す。バインド変数の番号は通しで振る", () => {
    const text = `WITH a AS (SELECT * FROM t WHERE k = :k)
SELECT * FROM a ORDER BY x OPTION (RECOMPILE)`;
    const q = buildSelect({
      dialect: "mssql",
      source: {
        kind: "report",
        sql: text,
        config: {},
        values: { k: "A" },
      },
      columns: [
        {
          name: "X",
          type: {
            kind: "string",
            unicode: true,
            fixedLength: false,
            length: 10,
          },
        },
      ],
      filters: { X: { kind: "set", values: ["B"] } },
      limit: 11,
    });
    expect(q.sql).toBe(
      [
        "WITH a AS (SELECT * FROM t WHERE k = @p1)",
        "SELECT TOP (@p2) *",
        "FROM (",
        "SELECT * FROM a",
        "OPTION (RECOMPILE)",
        ") base_query",
        "WHERE [X] = @p3",
      ].join("\n"),
    );
    expect(q.params.map((p) => p.value)).toEqual(["A", 11, "B"]);
  });

  test("Oracle：ORDER BY は派生テーブルの中に残してよい", () => {
    const q = buildSelect({
      dialect: "oracle",
      source: {
        kind: "report",
        sql: "SELECT * FROM t WHERE k = :k ORDER BY x",
        config: {},
        values: { k: "A" },
      },
      columns: [],
    });
    expect(q.sql).toBe(
      "SELECT *\nFROM (\nSELECT * FROM t WHERE k = :p1 ORDER BY x\n) base_query",
    );
  });
});

describe("設定のコメント", () => {
  test("読み書き。SQL の本文はそのまま残す", () => {
    const written = writeReportConfig(SQL, {
      connection: "基幹（SQL Server）",
      ...config,
    });
    expect(written.startsWith("/* @report\n{")).toBe(true);
    expect(written.endsWith(SQL)).toBe(true);
    expect(parseReportConfig(written)).toEqual({
      config: { connection: "基幹（SQL Server）", ...config },
      error: null,
    });
    // 書き直しても、コメントは 1 つのまま
    const again = writeReportConfig(written, {});
    expect(again).toBe(`/* @report\n{}\n*/\n${SQL}`);
  });

  test("値に */ が入っても、コメントが途中で閉じない", () => {
    const written = writeReportConfig("SELECT 1", {
      params: { a: { label: "a */ b" } },
    });
    expect(parseReportConfig(written).config.params?.a?.label).toBe("a */ b");
    expect(written.endsWith("\nSELECT 1")).toBe(true);
  });

  test("コメントがなければ空の設定。読めないときは理由を返す", () => {
    expect(parseReportConfig("SELECT 1")).toEqual({ config: {}, error: null });
    const broken = parseReportConfig("/* @report { broken */ SELECT 1");
    expect(broken.config).toEqual({});
    expect(broken.error).toContain("読めません");
  });

  test("知らない項目と型の違う値は捨てる", () => {
    const { config: read } = parseReportConfig(`/* @report
{ "connection": 1, "x": 2, "params": { "a": { "type": "color", "required": "yes", "label": "A" }, "b": 3 } }
*/`);
    expect(read).toEqual({ params: { a: { label: "A" } } });
  });
});
