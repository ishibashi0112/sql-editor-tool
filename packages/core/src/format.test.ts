import { describe, expect, test } from "vitest";
import { mssql, oracle } from "./dialect";
import { firstDifference, formatSql, rejoinSplitParams } from "./format";

// 表名・列名は架空
const format = (sql: string, dialect = mssql) => {
  const result = formatSql(dialect, sql);
  if (!result.ok) throw new Error(result.message);
  return result.text;
};

describe("formatSql（SQL Server）", () => {
  test(":名前 と @名前 を分けない（ほかの整形の拡張は「BETWEEN: 開始」にしていた）", () => {
    const text = format(
      "select o.ORDER_NO from dbo.ORDERS o where o.YMD between :開始 and :終了 and (@得意先 is null or o.CUST_CD = @得意先) and o.A = :code and @@ROWCOUNT = 0",
    );
    expect(text).toContain("between :開始 and :終了");
    expect(text).toContain("@得意先 is null");
    expect(text).toContain("o.A = :code");
    expect(text).toContain("@@ROWCOUNT = 0");
    expect(text).toBe(
      [
        "select",
        "  o.ORDER_NO",
        "from",
        "  dbo.ORDERS o",
        "where",
        "  o.YMD between :開始 and :終了",
        "  and (",
        "    @得意先 is null",
        "    or o.CUST_CD = @得意先",
        "  )",
        "  and o.A = :code",
        "  and @@ROWCOUNT = 0",
      ].join("\n"),
    );
  });

  test("ほかの整形の拡張で分かれた「: 名前」を戻す（予約語の前の : と :: は戻さない）", () => {
    const result = formatSql(
      mssql,
      "SELECT * FROM T WHERE D BETWEEN: 開始 + '000000' AND: 終了 + '999999' AND E =: code AND G = geometry::Point(1, 2, 0)",
    );
    expect(result).toMatchObject({ ok: true, rejoined: 3 });
    expect(result.ok && result.text).toContain(
      "D BETWEEN :開始 + '000000' AND :終了 + '999999'",
    );
    expect(result.ok && result.text).toContain("E = :code");
    expect(rejoinSplitParams(mssql, "a: SELECT 1").rejoined).toBe(0);
    expect(rejoinSplitParams(mssql, "SELECT ': 開始' -- : 開始").rejoined).toBe(
      0,
    );
  });

  test("GO の行はそのまま残し、その間を整形する。コメント・文字列・日本語の名前はそのまま", () => {
    const text = format(
      [
        "-- 受注の確認",
        "select a, N'日本' as x from 受注 where 受注.日付 >= :開始日 -- 期間",
        "GO",
        "/* 2 つ目 */ select b from [得意先 マスタ]",
        "go",
        "",
      ].join("\n"),
    );
    expect(text).toBe(
      [
        "-- 受注の確認",
        "select",
        "  a,",
        "  N'日本' as x",
        "from",
        "  受注",
        "where",
        "  受注.日付 >= :開始日 -- 期間",
        "GO",
        "",
        "/* 2 つ目 */",
        "select",
        "  b",
        "from",
        "  [得意先 マスタ]",
        "go",
        "",
      ].join("\n"),
    );
  });

  test("設定：キーワードを大文字に、タブでインデント", () => {
    const result = formatSql(mssql, "select a from t where b = :x", {
      keywordCase: "upper",
      useTabs: true,
    });
    expect(result).toEqual({
      ok: true,
      rejoined: 0,
      text: "SELECT\n\ta\nFROM\n\tt\nWHERE\n\tb = :x",
    });
  });

  test("読めない SQL は整形せず、行を伝える", () => {
    const result = formatSql(mssql, "select 1\nselect 'abc from t");
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("2 行目"),
    });
  });
});

describe("formatSql（Oracle）", () => {
  test("/ の行を前の行に付けない。:名前・:1・(+)・DB リンク・q'[...]' はそのまま", () => {
    const text = format(
      "select a.x, nvl(b.y, 0) from t a, u@link b where a.id = b.id(+) and a.d >= :開始 and a.n = :1 and q'[it's]' = 'x'\n/\nselect 1 from dual\n/\n",
      oracle,
    );
    expect(text).toBe(
      [
        "select",
        "  a.x,",
        "  nvl(b.y, 0)",
        "from",
        "  t a,",
        "  u@link b",
        "where",
        "  a.id = b.id (+)",
        "  and a.d >= :開始",
        "  and a.n = :1",
        "  and q'[it's]' = 'x'",
        "/",
        "",
        "select",
        "  1",
        "from",
        "  dual",
        "/",
        "",
      ].join("\n"),
    );
  });
});

describe("firstDifference（整形の前後で中身が変わっていないか）", () => {
  test("空白・改行・キーワードの大文字小文字・コメントの中の空白の違いは同じとみなす", () => {
    expect(
      firstDifference(
        mssql,
        "select a -- メモ\nfrom t where x = :開始 /* 複数\n   行 */",
        "SELECT\n  a -- メモ\nFROM\n  t\nWHERE\n  x = :開始 /* 複数\n行 */",
      ),
    ).toBeNull();
  });

  test("字句・文字列・:名前・コメントが違えば、どこかを返す", () => {
    expect(firstDifference(mssql, "select a from t", "select b from t")).toBe(
      "1 行目の「a」のあたり",
    );
    expect(
      firstDifference(mssql, "where x = :開始", "where x =: 開始"),
    ).not.toBeNull();
    expect(
      firstDifference(mssql, "select 'a  b'", "select 'a b'"),
    ).not.toBeNull();
    expect(firstDifference(mssql, "select 1 -- メモ", "select 1 -- めも")).toBe(
      "1 行目のコメント",
    );
    expect(firstDifference(mssql, "select 1", "select 1, 2")).not.toBeNull();
    expect(
      firstDifference(
        oracle,
        "select 1 from dual\n/\n",
        "select 1 from dual /",
      ),
    ).toBe("GO や / だけの行");
  });
});
