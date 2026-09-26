import { describe, expect, test } from "vitest";
import { assertReadOnlyQuery } from "./readOnly";
import { buildSelect } from "./select";
import { columns } from "./testColumns";

describe("assertReadOnlyQuery", () => {
  test("core が組み立てた SELECT はそのまま通す", () => {
    for (const dialect of ["mssql", "oracle"] as const) {
      const q = buildSelect({
        dialect,
        source: { kind: "table", table: { schema: "APP", name: "ORDERS" } },
        columns,
        filters: { CUST_NAME: { kind: "text", value: "delete" } },
        limit: 10,
      });
      expect(() => assertReadOnlyQuery(dialect, q.sql)).not.toThrow();
    }
  });

  test("WITH で始まる問い合わせも通す", () => {
    expect(() =>
      assertReadOnlyQuery(
        "mssql",
        "WITH a AS (SELECT 1 AS x) SELECT * FROM (SELECT x FROM a) base_query",
      ),
    ).not.toThrow();
  });

  test("文字列・引用符つきの名前・コメントの中の語は見ない", () => {
    expect(() =>
      assertReadOnlyQuery(
        "mssql",
        "/* DELETE */ SELECT [UPDATE], N'INSERT; DROP' FROM t -- EXEC\n",
      ),
    ).not.toThrow();
    expect(() =>
      assertReadOnlyQuery("oracle", `SELECT "INTO" FROM t WHERE c = 'MERGE'`),
    ).not.toThrow();
  });

  test("SELECT / WITH 以外で始まる文は実行しない", () => {
    for (const text of ["DELETE FROM t", "EXEC sp_who", "", "  -- 空\n"]) {
      expect(() => assertReadOnlyQuery("mssql", text)).toThrow("読み取り専用");
    }
  });

  test("書き込みの語が紛れ込んでいたら実行しない", () => {
    // T-SQL はセミコロンなしで文を続けられる
    expect(() =>
      assertReadOnlyQuery("mssql", "SELECT 1 AS x DELETE FROM t"),
    ).toThrow("DELETE");
    expect(() =>
      assertReadOnlyQuery("mssql", "SELECT * INTO #w FROM t"),
    ).toThrow("INTO");
    expect(() =>
      assertReadOnlyQuery("oracle", "SELECT * FROM t FOR UPDATE"),
    ).toThrow("UPDATE");
  });

  test("セミコロンで区切った文は実行しない", () => {
    expect(() => assertReadOnlyQuery("oracle", "SELECT 1 FROM dual;")).toThrow(
      "複数の文",
    );
  });

  test("解釈できない SQL は実行しない", () => {
    expect(() => assertReadOnlyQuery("oracle", "SELECT 'abc FROM t")).toThrow(
      "解釈できません",
    );
  });
});
