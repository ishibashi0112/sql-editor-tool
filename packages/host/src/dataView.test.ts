import { describe, expect, test } from "vitest";
import { DataViewController, type DataViewSettings } from "./dataView";
import { DemoSession } from "./demo/demoSession";
import type { ToWebview } from "./protocol";
import type { DbSession } from "./session";

const table = { schema: "APP", name: "ORDERS" };

function setup(
  settings: Partial<DataViewSettings> = {},
  session: DbSession = new DemoSession({ dialect: "mssql", chunkDelayMs: 0 }),
) {
  const messages: ToWebview[] = [];
  const copied: string[] = [];
  const controller = new DataViewController({
    session,
    table,
    settings: { maxRows: 100000, filterOptionsLimit: 10000, ...settings },
    demo: true,
    post: (message) => messages.push(message),
    copyText: async (text) => {
      copied.push(text);
    },
  });
  const ofType = <T extends ToWebview["type"]>(type: T) =>
    messages.filter(
      (m): m is Extract<ToWebview, { type: T }> => m.type === type,
    );
  return { controller, messages, copied, ofType };
}

describe("DataViewController", () => {
  test("ready で列と SQL プレビューを送る。並べ替えの既定は主キー", async () => {
    const { controller, ofType } = setup();
    await controller.handle({ type: "ready" });
    const [init] = ofType("init");
    expect(init?.view.title).toBe("APP.ORDERS");
    expect(
      init?.view.columns.filter((c) => c.isKey).map((c) => c.name),
    ).toEqual(["ORDER_NO", "LINE_NO"]);
    const [preview] = ofType("preview");
    expect(preview?.preview).toMatchObject({ ok: true });
    expect(preview?.preview.ok && preview.preview.sql).toContain(
      "ORDER BY [ORDER_NO] ASC, [LINE_NO] ASC",
    );
  });

  test("条件が変わったらプレビューだけ更新する（実行はしない）", async () => {
    const { controller, ofType } = setup();
    await controller.handle({ type: "ready" });
    await controller.handle({
      type: "conditionsChanged",
      filters: { STATUS: { kind: "set", values: ["10"] } },
      sort: [{ columnKey: "QTY", direction: "desc" }],
    });
    const last = ofType("preview").at(-1)?.preview;
    expect(last?.ok && last.sql).toContain("WHERE [STATUS] = @p2");
    expect(last?.ok && last.literalSql).toContain("ORDER BY [QTY] DESC");
    expect(ofType("queryStarted")).toHaveLength(0);
  });

  test("組み立てられない条件はプレビューにエラーとして出す", async () => {
    const { controller, ofType } = setup();
    await controller.handle({ type: "ready" });
    await controller.handle({
      type: "conditionsChanged",
      filters: { NO_SUCH: { kind: "text", value: "x" } },
      sort: [],
    });
    expect(ofType("preview").at(-1)?.preview).toMatchObject({
      ok: false,
      columnKey: "NO_SUCH",
    });
  });

  test("実行すると行をチャンクで送り、上限を超えたら打ち切る", async () => {
    const { controller, ofType } = setup({ maxRows: 4500 });
    await controller.handle({ type: "ready" });
    await controller.handle({ type: "execute" });
    const rows = ofType("rows").flatMap((m) => m.rows);
    expect(rows).toHaveLength(4500);
    expect(ofType("rows").length).toBeGreaterThan(1);
    expect(ofType("queryDone")[0]).toMatchObject({
      rowCount: 4500,
      truncated: true,
    });
    expect(ofType("queryFailed")).toHaveLength(0);
  });

  test("上限に届かなければ打ち切りではない", async () => {
    const { controller, ofType } = setup();
    await controller.handle({ type: "ready" });
    await controller.handle({ type: "execute" });
    expect(ofType("queryDone")[0]).toMatchObject({
      rowCount: 20000,
      truncated: false,
    });
  });

  test("キャンセルすると cancelled で終わる", async () => {
    const session = new DemoSession({ dialect: "oracle", chunkDelayMs: 5 });
    const { controller, ofType } = setup({}, session);
    await controller.handle({ type: "ready" });
    const running = controller.handle({ type: "execute" });
    await controller.handle({ type: "cancel" });
    await running;
    expect(ofType("queryFailed")[0]).toMatchObject({ cancelled: true });
    expect(ofType("queryDone")).toHaveLength(0);
  });

  test("結果の列の並びが違えば、画面の列の順に並べ替える", async () => {
    const demo = new DemoSession({ dialect: "mssql", chunkDelayMs: 0 });
    const session: DbSession = {
      dialect: "mssql",
      listSchemas: () => demo.listSchemas(),
      listObjects: (schema) => demo.listObjects(schema),
      describeTable: async () => ({
        columns: [
          { name: "A", type: { kind: "number", precision: null, scale: null } },
          { name: "B", type: { kind: "number", precision: null, scale: null } },
        ],
        primaryKey: [],
      }),
      query: async (_request, handlers) => {
        handlers.onColumns(["B", "A"]);
        handlers.onRows([[2, 1]]);
      },
      close: async () => {},
    };
    const { controller, ofType } = setup({}, session);
    await controller.handle({ type: "ready" });
    await controller.handle({ type: "execute" });
    expect(ofType("rows")[0]?.rows).toEqual([[1, 2]]);
  });

  test("集合フィルタの候補：空欄を先頭にし、上限で打ち切る", async () => {
    const { controller, ofType } = setup({ filterOptionsLimit: 3 });
    await controller.handle({ type: "ready" });
    await controller.handle({
      type: "getFilterOptions",
      requestId: 7,
      columnKey: "SHIP_YMD",
      columnFilters: {},
    });
    const [result] = ofType("filterOptions");
    expect(result?.requestId).toBe(7);
    expect(result?.result.truncated).toBe(true);
    expect(result?.result.options[0]).toEqual({ label: "（空白）", value: "" });
    expect(result?.result.options).toHaveLength(3);
  });

  test("日付型の列の候補は 'YYYY-MM-DD'", async () => {
    const { controller, ofType } = setup();
    await controller.handle({ type: "ready" });
    await controller.handle({
      type: "getFilterOptions",
      requestId: 1,
      columnKey: "UPDATED_AT",
      columnFilters: {},
    });
    const values = ofType("filterOptions")[0]?.result.options.map(
      (o) => o.value,
    );
    expect(values?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("SQL のコピーは、バインド版とリテラル版を選べる", async () => {
    const { controller, copied } = setup();
    await controller.handle({ type: "ready" });
    await controller.handle({
      type: "conditionsChanged",
      filters: { CUST_CD: { kind: "set", values: ["C00001"] } },
      sort: [],
    });
    await controller.handle({ type: "copySql", variant: "bind" });
    await controller.handle({ type: "copySql", variant: "literal" });
    expect(copied[0]).toContain("[CUST_CD] = @p2");
    expect(copied[1]).toContain("[CUST_CD] = 'C00001'");
  });
});
