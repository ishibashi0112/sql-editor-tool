import { describe, expect, test } from "vitest";
import {
  guessReportParamTypes,
  hasRelativeDefault,
  looksLikeDateName,
  parseReportConfig,
  type ReportConfig,
  type ReportParam,
  reportDefaultValue,
  reportParamProbe,
  reportParams,
  withGuessedTypes,
  writeReportConfig,
} from "./report";
import { buildOptionsQuery, buildReportQuery, buildSelect } from "./select";

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
        options: "",
        guessed: false,
      },
      {
        name: "得意先",
        label: "得意先",
        type: "text",
        required: false,
        default: "",
        options: "",
        guessed: false,
      },
    ]);
  });

  test("推定した種類は、設定に種類がない入力欄だけに使う", () => {
    const params = reportParams(
      "mssql",
      `${SQL} AND 数量 = :数量`,
      { params: { 開始日: { type: "ymd" }, 数量: { label: "数量（個）" } } },
      { 開始日: "text", 得意先: "text", 数量: "number" },
    );
    expect(params.map((p) => [p.name, p.type, p.guessed, p.label])).toEqual([
      ["開始日", "ymd", false, "開始日"],
      ["得意先", "text", true, "得意先"],
      ["数量", "number", true, "数量（個）"],
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
    // Oracle の文字列は CHAR でバインドする（CHAR 列と一致し、VARCHAR2 列の索引も効く。D-38）
    expect(q.params[1]?.type).toEqual({
      kind: "string",
      unicode: false,
      fixedChar: true,
    });
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

describe("既定値（相対の日付、D-32・D-33）", () => {
  const now = new Date(2026, 8, 26);
  const param = (type: ReportParam["type"], value: string): ReportParam => ({
    name: "d",
    label: "d",
    type,
    required: true,
    default: value,
    options: "",
    guessed: false,
  });

  test("日付の種類で相対の日付なら、now を基準に計算する", () => {
    expect(reportDefaultValue(param("ymd", "月初-1か月"), now)).toBe(
      "2026-08-01",
    );
    expect(reportDefaultValue(param("date", "今日"), now)).toBe("2026-09-26");
    expect(hasRelativeDefault(param("date", "今日"))).toBe(true);
  });

  test("日付そのものや、日付でない種類は、書いたまま", () => {
    expect(reportDefaultValue(param("ymd", "20260901"), now)).toBe("20260901");
    expect(reportDefaultValue(param("text", "今日"), now)).toBe("今日");
    expect(hasRelativeDefault(param("text", "今日"))).toBe(false);
    expect(hasRelativeDefault(param("ymd", "2026-09-01"))).toBe(false);
  });
});

describe("選択肢（D-34）", () => {
  test("設定の options を読み書きする。値は文字列で渡す", () => {
    const text = `/* @report
{ "params": { "得意先": { "type": "select", "options": "SELECT コード, 名前 FROM 得意先" } } }
*/
SELECT * FROM 受注 WHERE 得意先コード = :得意先`;
    const { config } = parseReportConfig(text);
    const [param] = reportParams("mssql", text, config);
    expect(param?.type).toBe("select");
    expect(param?.options).toBe("SELECT コード, 名前 FROM 得意先");
    const q = buildReportQuery({
      dialect: "mssql",
      sql: text,
      config,
      values: { 得意先: "C001" },
    });
    expect(q.params[0]).toEqual({
      name: "p1",
      value: "C001",
      type: { kind: "string", unicode: true },
    });
  });

  test("候補の SQL はそのまま実行する形にする。:名前 と読み取り専用でない文は使えない", () => {
    expect(
      buildOptionsQuery("oracle", "SELECT code, name FROM t ORDER BY code;")
        .sql,
    ).toBe("SELECT code, name FROM t ORDER BY code");
    expect(() =>
      buildOptionsQuery("mssql", "SELECT code FROM t WHERE k = :k"),
    ).toThrow("候補の SQL には :名前 は使えません（:k）");
    expect(() => buildOptionsQuery("mssql", "DELETE FROM t")).toThrow(
      "候補の SQL は SELECT か WITH で始まる",
    );
  });
});

describe("入力欄の種類の推定（D-35）", () => {
  test(":名前 を出現ごとに別のバインド変数にし、IS NULL の出現に印を付ける", () => {
    expect(reportParamProbe("mssql", SQL)).toEqual({
      sql: `SELECT * FROM 受注
WHERE 受注日 >= @p1
  AND (@p2 IS NULL OR 得意先コード = @p3)`,
      occurrences: [
        { placeholder: "p1", name: "開始日", nullCheck: false },
        { placeholder: "p2", name: "得意先", nullCheck: true },
        { placeholder: "p3", name: "得意先", nullCheck: false },
      ],
    });
  });

  test("名前ごとに、最初の出現（IS NULL を除く）の推定を使う", () => {
    const probe = reportParamProbe(
      "mssql",
      `${SQL} AND 数量 = :数量 AND 登録日時 >= :登録 AND 備考 = :数量 AND x = :x`,
    );
    expect(
      guessReportParamTypes(probe, {
        p1: { kind: "string", length: 4000 },
        p2: { kind: "number" },
        p3: { kind: "string", length: 8 },
        p4: { kind: "number" },
        p5: { kind: "date" },
        p6: { kind: "string", length: 100 },
        p7: { kind: "other" },
      }),
    ).toEqual({ 開始日: "ymd", 得意先: "text", 数量: "number", 登録: "date" });
  });

  test("推定できなかった名前は含めない", () => {
    const probe = reportParamProbe("mssql", SQL);
    expect(guessReportParamTypes(probe, { p1: { kind: "date" } })).toEqual({
      開始日: "date",
    });
  });

  test("文字列は、長さが 8 か分からない（4000 以上）で、名前が日付らしいときだけ ymd", () => {
    const probe = reportParamProbe(
      "mssql",
      "SELECT * FROM t WHERE a = :終了日 AND b = :出荷日 AND c = :納期日 AND d = :コード",
    );
    expect(
      guessReportParamTypes(probe, {
        p1: { kind: "string", length: 8 },
        p2: { kind: "string", length: null },
        p3: { kind: "string", length: 10 },
        p4: { kind: "string", length: 8 },
      }),
    ).toEqual({ 終了日: "ymd", 出荷日: "ymd", 納期日: "text", コード: "text" });
  });

  test("日付らしい名前", () => {
    for (const name of [
      "開始日",
      "受注日_FROM",
      "SHIP_YMD",
      "OrderDate",
      "UPD_DT",
      "日付",
    ]) {
      expect(looksLikeDateName(name), name).toBe(true);
    }
    for (const name of [
      "日数",
      "曜日",
      "日本語名",
      "得意先",
      "DTYPE",
      "WIDTH",
    ]) {
      expect(looksLikeDateName(name), name).toBe(false);
    }
  });

  test("withGuessedTypes は設定の種類を上書きしない", () => {
    expect(
      withGuessedTypes(
        { connection: "c", params: { a: { type: "ymd" }, b: { label: "B" } } },
        { a: "text", b: "number", c: "date" },
      ),
    ).toEqual({
      connection: "c",
      params: {
        a: { type: "ymd" },
        b: { label: "B", type: "number" },
        c: { type: "date" },
      },
    });
  });
});
