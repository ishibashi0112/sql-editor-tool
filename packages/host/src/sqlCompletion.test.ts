import { describe, expect, test } from "vitest";
import { DemoSession } from "./demo/demoSession";
import type { DbSession } from "./session";
import {
  type CompletionEntry,
  completeSql,
  SchemaCache,
} from "./sqlCompletion";

/** 呼ばれた回数を数えるデモ接続（テーブルは APP.ORDERS・CUSTOMERS・ITEMS・V_OPEN_ORDERS） */
function counting() {
  const demo = new DemoSession({ dialect: "mssql", chunkDelayMs: 0 });
  const calls = { objects: 0, describe: [] as string[], fail: false };
  const session: DbSession = {
    dialect: "mssql",
    listSchemas: () => demo.listSchemas(),
    listObjects: (schema) => demo.listObjects(schema),
    listAllObjects: async () => {
      calls.objects += 1;
      if (calls.fail) throw new Error("接続できません");
      return demo.listAllObjects();
    },
    describeTable: async (table) => {
      calls.describe.push(table.name);
      return demo.describeTable(table);
    },
    query: (request, handlers) => demo.query(request, handlers),
    close: async () => {},
  };
  return { cache: new SchemaCache(async () => session), calls };
}

/** | の位置で補完する */
async function complete(text: string, cache: SchemaCache | null) {
  return completeSql({
    dialect: "mssql",
    text: text.replace("|", ""),
    offset: text.indexOf("|"),
    cache,
  });
}
const labels = (entries: CompletionEntry[]) => entries.map((e) => e.label);

describe("completeSql", () => {
  test("「テーブル.」の後は列（テーブルの列の順、主キーは key）", async () => {
    const { cache } = counting();
    const entries = await complete("SELECT ORDERS.|", cache);
    expect(labels(entries).slice(0, 3)).toEqual([
      "ORDER_NO",
      "LINE_NO",
      "CUST_CD",
    ]);
    expect(entries[0]).toMatchObject({
      kind: "key",
      detail: "文字列(10)・主キー（ORDERS）",
      insertText: "ORDER_NO",
    });
    expect(entries[2]?.kind).toBe("column");
  });

  test("別名・小文字・スキーマつきの名前でも列を出す", async () => {
    const { cache } = counting();
    expect(
      labels(
        await complete(
          "SELECT c.| FROM APP.ORDERS o JOIN CUSTOMERS c ON 1 = 1",
          cache,
        ),
      ),
    ).toContain("CUST_NAME");
    expect(labels(await complete("select orders.|", cache))).toContain("QTY");
    expect(labels(await complete("SELECT APP.ITEMS.|", cache))).toContain(
      "ITEM_CD",
    );
  });

  test("FROM の後はテーブル・ビュー・スキーマ。「スキーマ.」の後はそのスキーマのテーブル", async () => {
    const { cache } = counting();
    const entries = await complete("SELECT * FROM |", cache);
    expect(
      entries.filter((e) => e.kind === "table").map((e) => e.label),
    ).toContain("ORDERS");
    expect(entries.find((e) => e.label === "V_OPEN_ORDERS")?.kind).toBe("view");
    expect(entries.find((e) => e.kind === "schema")?.label).toBe("APP");
    expect(labels(await complete("SELECT * FROM APP.|", cache))).toContain(
      "CUSTOMERS",
    );
    // FROM の後でなくても、テーブル名でない「スキーマ.」ならテーブル
    expect(labels(await complete("SELECT APP.|", cache))).toContain("ITEMS");
  });

  test("派生テーブルの別名や、分からない名前は出さない", async () => {
    const { cache } = counting();
    expect(
      await complete("SELECT s.| FROM (SELECT * FROM ORDERS) s", cache),
    ).toEqual([]);
    expect(await complete("SELECT nothing.|", cache)).toEqual([]);
  });

  test("それ以外の位置はキーワード。接続がなくても出す", async () => {
    const entries = await complete("SELECT * FROM ORDERS WH|", null);
    expect(labels(entries)).toContain("WHERE");
    expect(entries.every((e) => e.kind === "keyword")).toBe(true);
    expect(await complete("SELECT ORDERS.|", null)).toEqual([]);
    expect(await complete("SELECT 'ORDERS.|'", null)).toEqual([]);
  });

  test("一覧と列は覚えておき、補完のたびには問い合わせない", async () => {
    const { cache, calls } = counting();
    await complete("SELECT ORDERS.|", cache);
    await complete("SELECT o.| FROM ORDERS o", cache);
    await complete("SELECT * FROM |", cache);
    expect(calls.objects).toBe(1);
    expect(calls.describe).toEqual(["ORDERS"]);
    cache.clear();
    await complete("SELECT ORDERS.|", cache);
    expect(calls.objects).toBe(2);
    expect(calls.describe).toEqual(["ORDERS", "ORDERS"]);
  });

  test("一覧の取得に失敗したら覚えず、次に試し直す", async () => {
    const { cache, calls } = counting();
    calls.fail = true;
    await expect(complete("SELECT * FROM |", cache)).rejects.toThrow(
      "接続できません",
    );
    calls.fail = false;
    expect(labels(await complete("SELECT * FROM |", cache))).toContain(
      "ORDERS",
    );
    expect(calls.objects).toBe(2);
  });
});
