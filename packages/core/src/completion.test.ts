import { describe, expect, test } from "vitest";
import {
  completionContext,
  completionIdentifier,
  sqlKeywords,
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
