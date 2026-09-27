import { describe, expect, test } from "vitest";
import { DemoSession } from "./demo/demoSession";
import { SchemaCache } from "./sqlCompletion";
import {
  describeResultColumns,
  resolveSymbols,
  type SqlSymbol,
  symbolAt,
} from "./sqlSymbols";

// デモ接続の架空のテーブル（APP.ORDERS＝受注明細、CUSTOMERS＝得意先、ITEMS＝品目、V_OPEN_ORDERS）
const cache = () =>
  new SchemaCache(
    async () => new DemoSession({ dialect: "mssql", chunkDelayMs: 0 }),
  );

/** 名前 → 論理名（論理名がなければ名前だけ） */
const describeSymbol = (text: string) => (s: SqlSymbol) => {
  const written = text.slice(s.start, s.end);
  const label =
    s.kind === "table" ? s.object.logicalName : s.column.logicalName;
  return `${written}${s.kind === "column" && s.isKey ? "🔑" : ""}=${label ?? ""}`;
};

describe("resolveSymbols", () => {
  test("テーブル名・別名.列・列を、文の FROM・JOIN のテーブルから決める", async () => {
    const text = `SELECT o.ORDER_NO, QTY, c.CUST_NAME, APP.ITEMS.ITEM_NAME
FROM APP.ORDERS o
JOIN CUSTOMERS c ON c.CUST_CD = o.CUST_CD
WHERE o.ORDER_YMD >= :開始日 AND STATUS = '10'`;
    const symbols = await resolveSymbols({
      dialect: "mssql",
      text,
      cache: cache(),
    });
    expect(symbols.map(describeSymbol(text))).toEqual([
      "ORDER_NO🔑=受注番号",
      "QTY=数量",
      "CUST_NAME=得意先名",
      "ITEM_NAME=品目名",
      "ORDERS=受注明細",
      "CUSTOMERS=得意先",
      "CUST_CD🔑=得意先コード",
      "CUST_CD=得意先コード",
      "ORDER_YMD=受注日",
      "STATUS=状態区分",
    ]);
  });

  test("複数のテーブルにあって論理名が違う列、分からない名前、派生テーブルの列は決めない", async () => {
    const text = `SELECT ORDER_NO, CUST_CD, x.QTY, NOTHING
FROM ORDERS JOIN V_OPEN_ORDERS v ON 1 = 1
JOIN (SELECT QTY FROM ORDERS) x ON 1 = 1`;
    const symbols = await resolveSymbols({
      dialect: "mssql",
      text,
      cache: cache(),
    });
    // ORDER_NO は ORDERS（受注番号）と V_OPEN_ORDERS（論理名なし）にあるので決めない
    expect(symbols.map(describeSymbol(text))).toEqual([
      "ORDERS=受注明細",
      "V_OPEN_ORDERS=未完了の受注",
      "QTY=数量",
      "ORDERS=受注明細",
    ]);
  });

  test("範囲に掛かる名前だけを決める。文ごとにテーブルを見る", async () => {
    const text = "SELECT QTY FROM ORDERS;\nSELECT PREF FROM CUSTOMERS";
    const from = text.indexOf("PREF");
    const symbols = await resolveSymbols({
      dialect: "mssql",
      text,
      cache: cache(),
      from,
      to: text.length,
    });
    expect(symbols.map(describeSymbol(text))).toEqual([
      "PREF=都道府県",
      "CUSTOMERS=得意先",
    ]);
  });

  test("別名は、論理名と同じならヒントを出さないために返す", async () => {
    const text = "SELECT QTY AS 数量, UNIT_PRICE 単価 FROM ORDERS";
    const symbols = await resolveSymbols({
      dialect: "mssql",
      text,
      cache: cache(),
    });
    expect(symbols.map((s) => s.alias)).toEqual(["数量", "単価", null]);
  });
});

describe("symbolAt", () => {
  test("カーソルの位置の名前（なければ null）", async () => {
    const text = "SELECT o.SHIP_YMD FROM ORDERS o";
    const at = (word: string, delta = 1) =>
      symbolAt({
        dialect: "mssql",
        text,
        cache: cache(),
        offset: text.indexOf(word) + delta,
      });
    expect(await at("SHIP_YMD")).toMatchObject({
      kind: "column",
      column: { logicalName: "出荷日", comment: "yyyymmdd。未出荷は空" },
      table: { name: "ORDERS" },
    });
    expect(await at("ORDERS")).toMatchObject({ kind: "table" });
    expect(await at("SELECT")).toBeNull();
  });
});

describe("describeResultColumns", () => {
  test("FROM・JOIN のテーブルに 1 つだけある列の論理名。別名の列・式・論理名が割れる列は付けない", async () => {
    const text = `/* @report {} */
SELECT o.ORDER_NO, o.QTY AS 数, c.CUST_NAME, o.CUST_CD, PREF
FROM ORDERS o JOIN CUSTOMERS c ON c.CUST_CD = o.CUST_CD
WHERE EXISTS (SELECT 1 FROM ITEMS i WHERE i.ITEM_CD = o.ITEM_CD)`;
    const notes = await describeResultColumns({
      dialect: "mssql",
      text,
      cache: cache(),
      names: [
        "ORDER_NO",
        "数",
        "CUST_NAME",
        "CUST_CD",
        "PREF",
        "ITEM_NAME",
        "",
      ],
    });
    expect(notes).toEqual([
      { logicalName: "受注番号" },
      {},
      { logicalName: "得意先名" },
      // ORDERS と CUSTOMERS の両方にあるが、論理名が同じ
      { logicalName: "得意先コード" },
      { logicalName: "都道府県" },
      // 副問い合わせのテーブルの列も探す
      { logicalName: "品目名" },
      {},
    ]);
  });
});
