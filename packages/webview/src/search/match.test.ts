import type { SchemaObject } from "@sql-editor-tool/host";
import { describe, expect, test } from "vitest";
import { searchObjects } from "./match";

// 架空の名前
const objects: SchemaObject[] = [
  { schema: "dbo", name: "受注明細", kind: "table" },
  { schema: "dbo", name: "受注", kind: "table" },
  { schema: "dbo", name: "V_受注一覧", kind: "view" },
  { schema: "sales", name: "ORDERS", kind: "table" },
  { schema: "work", name: "受注_BK", kind: "table" },
  { schema: "dbo", name: "ｼﾞｭﾁｭｳ", kind: "table" },
];

const names = (query: string, limit = 100) =>
  searchObjects(objects, query, limit).hits.map((h) => h.object.name);

describe("searchObjects", () => {
  test("名前が語で始まるもの、含むものの順。同じなら短い順", () => {
    expect(names("受注")).toEqual([
      "受注",
      "受注明細",
      "受注_BK",
      "V_受注一覧",
    ]);
  });

  test("大文字小文字、全角半角を区別しない", () => {
    expect(names("orders")).toEqual(["ORDERS"]);
    expect(names("ＯＲＤ")).toEqual(["ORDERS"]);
    expect(names("ジュチュウ")).toEqual(["ｼﾞｭﾁｭｳ"]);
  });

  test("空白で区切った語はすべて含むもの。スキーマでも絞れる", () => {
    expect(names("受注 dbo")).toEqual(["受注", "受注明細", "V_受注一覧"]);
    expect(names("work.受注")).toEqual(["受注_BK"]);
    expect(names("sales")).toEqual(["ORDERS"]);
  });

  test("上限で打ち切っても、全体の件数を返す", () => {
    const result = searchObjects(objects, "受注", 2);
    expect(result.hits).toHaveLength(2);
    expect(result.total).toBe(4);
  });

  test("最初の語に一致した範囲を返す。正規化で文字数が変わる名前は返さない", () => {
    const hits = searchObjects(objects, "注一", 10).hits;
    expect(hits[0]?.highlight).toEqual([3, 5]);
    expect(searchObjects(objects, "ジュ", 10).hits[0]?.highlight).toBeNull();
  });

  test("空の検索は何も返さない", () => {
    expect(searchObjects(objects, "  ", 10)).toEqual({ hits: [], total: 0 });
  });
});
