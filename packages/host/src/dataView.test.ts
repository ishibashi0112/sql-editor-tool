import type { TableSettings } from "@sql-editor-tool/core";
import { describe, expect, test } from "vitest";
import { DataViewController, type DataViewSettings } from "./dataView";
import { DemoSession } from "./demo/demoSession";
import type { ToWebview } from "./protocol";
import type { DbSession, QueryRequest } from "./session";

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
    settings: { maxRows: 100000, ...settings },
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

/** デモ接続に渡した問い合わせを記録する */
function recording() {
  const demo = new DemoSession({ dialect: "mssql", chunkDelayMs: 0 });
  const requests: QueryRequest[] = [];
  const session: DbSession = {
    dialect: "mssql",
    listSchemas: () => demo.listSchemas(),
    listObjects: (schema) => demo.listObjects(schema),
    listAllObjects: () => demo.listAllObjects(),
    describeTable: (table) => demo.describeTable(table),
    query: (request, handlers) => {
      requests.push(request);
      return demo.query(request, handlers);
    },
    close: async () => {},
  };
  return { session, requests };
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
    await controller.handle({ type: "execute", mode: "all" });
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
    await controller.handle({ type: "execute", mode: "all" });
    expect(ofType("queryDone")[0]).toMatchObject({
      rowCount: 20000,
      truncated: false,
    });
  });

  test("キャンセルすると cancelled で終わる", async () => {
    const session = new DemoSession({ dialect: "oracle", chunkDelayMs: 5 });
    const { controller, ofType } = setup({}, session);
    await controller.handle({ type: "ready" });
    const running = controller.handle({ type: "execute", mode: "all" });
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
      listAllObjects: () => demo.listAllObjects(),
      describeTable: async () => ({
        columns: [
          { name: "A", type: { kind: "number", precision: null, scale: null } },
          { name: "B", type: { kind: "number", precision: null, scale: null } },
        ],
        primaryKey: [],
      }),
      query: async (_request, handlers) => {
        const type = { kind: "number", precision: null, scale: null } as const;
        handlers.onColumns([
          { name: "B", type },
          { name: "A", type },
        ]);
        handlers.onRows([[2, 1]]);
      },
      close: async () => {},
    };
    const { controller, ofType } = setup({}, session);
    await controller.handle({ type: "ready" });
    await controller.handle({ type: "execute", mode: "all" });
    expect(ofType("rows")[0]?.rows).toEqual([[1, 2]]);
  });

  test("実行（all）は画面の絞り込みを使わず、主キーの順で取る", async () => {
    const { session, requests } = recording();
    const { controller, ofType } = setup({}, session);
    await controller.handle({ type: "ready" });
    await controller.handle({
      type: "conditionsChanged",
      filters: { CUST_CD: { kind: "set", values: ["C00001"] } },
      sort: [{ columnKey: "QTY", direction: "desc" }],
    });
    await controller.handle({ type: "execute", mode: "all" });
    expect(requests[0]?.sql).not.toContain("WHERE");
    expect(requests[0]?.sql).toContain("ORDER BY [ORDER_NO] ASC");
    expect(ofType("queryStarted")[0]?.filters).toEqual({});
  });

  test("今の絞り込みで取り直す（filtered）は、WHERE と ORDER BY にして取る", async () => {
    const { session, requests } = recording();
    const { controller, ofType } = setup({}, session);
    await controller.handle({ type: "ready" });
    const filters = { CUST_CD: { kind: "set", values: ["C00001"] } } as const;
    await controller.handle({
      type: "conditionsChanged",
      filters: { ...filters },
      sort: [{ columnKey: "QTY", direction: "desc" }],
    });
    await controller.handle({ type: "execute", mode: "filtered" });
    expect(requests[0]?.sql).toContain("WHERE [CUST_CD] = @p2");
    expect(requests[0]?.sql).toContain("ORDER BY [QTY] DESC");
    // 画面は、DB で絞り込んだ条件を覚えておく（条件を広げたら取り直しを勧める）
    expect(ofType("queryStarted")[0]?.filters).toEqual(filters);
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

describe("列の設定（D-36・D-37）", () => {
  function withStore(
    name: string,
    initial: unknown = undefined,
  ): ReturnType<typeof setup> & { saved: TableSettings[] } {
    const saved: TableSettings[] = [];
    const messages: ToWebview[] = [];
    let stored = initial;
    const controller = new DataViewController({
      session: new DemoSession({ dialect: "mssql", chunkDelayMs: 0 }),
      table: { schema: "APP", name },
      settings: { maxRows: 100000 },
      demo: true,
      post: (message) => messages.push(message),
      copyText: async () => {},
      tableSettings: {
        load: () => stored,
        save: async (settings) => {
          stored = settings;
          saved.push(settings);
        },
      },
    });
    const ofType = <T extends ToWebview["type"]>(type: T) =>
      messages.filter(
        (m): m is Extract<ToWebview, { type: T }> => m.type === type,
      );
    return { controller, messages, copied: [], ofType, saved };
  }

  test("設定を保存したことがなければ、日付らしい列を案内する", async () => {
    const { controller, ofType } = withStore("ORDERS");
    await controller.handle({ type: "ready" });
    const view = ofType("init")[0]?.view;
    expect(view?.suggestion).toEqual(["ORDER_YMD", "SHIP_YMD"]);
    expect(view?.candidates).toEqual(["ORDER_YMD", "SHIP_YMD"]);
    expect(view?.settingsSaved).toBe(false);
    expect(view?.primaryKey).toEqual(["ORDER_NO", "LINE_NO"]);
  });

  test("案内を受けると、候補を日付として扱って保存し、画面を作り直す（絞り込みは外す）", async () => {
    const { controller, ofType, saved } = withStore("ORDERS");
    await controller.handle({ type: "ready" });
    await controller.handle({
      type: "conditionsChanged",
      filters: { STATUS: { kind: "set", values: ["10"] } },
      sort: [],
    });
    await controller.handle({ type: "acceptSuggestion" });
    expect(saved).toEqual([
      {
        semantic: {
          ORDER_YMD: { kind: "date", format: "yyyymmdd" },
          SHIP_YMD: { kind: "date", format: "yyyymmdd" },
        },
      },
    ]);
    const view = ofType("init").at(-1)?.view;
    expect(view?.columns.filter((c) => c.semantic).map((c) => c.name)).toEqual([
      "ORDER_YMD",
      "SHIP_YMD",
    ]);
    expect(view?.suggestion).toEqual([]);
    expect(view?.candidates).toEqual([]);
    const preview = ofType("preview").at(-1)?.preview;
    expect(preview?.ok && preview.sql).not.toContain("WHERE");
  });

  test("日付として扱う列の条件は、yyyymmdd の文字列で比べる", async () => {
    const { controller, ofType } = withStore("ORDERS", {
      semantic: { ORDER_YMD: { kind: "date", format: "yyyymmdd" } },
    });
    await controller.handle({ type: "ready" });
    expect(ofType("init")[0]?.view.suggestion).toEqual([]);
    await controller.handle({
      type: "conditionsChanged",
      filters: {
        ORDER_YMD: {
          kind: "dateSet",
          condition: { mode: "onOrAfter", value: "2026-09-01" },
          set: null,
        },
      },
      sort: [],
    });
    const preview = ofType("preview").at(-1)?.preview;
    expect(preview?.ok && preview.literalSql).toContain(
      "[ORDER_YMD] >= '20260901'",
    );
  });

  test("案内を使わないと、保存するが画面は作り直さない", async () => {
    const { controller, ofType, saved } = withStore("ORDERS");
    await controller.handle({ type: "ready" });
    await controller.handle({ type: "dismissSuggestion" });
    expect(saved).toEqual([{ suggestionDismissed: true }]);
    expect(ofType("init")).toHaveLength(1);
  });

  test("主キーのないビューでは、指定したキーの順で取る。主キーがあれば指定は無視する", async () => {
    const view = withStore("V_OPEN_ORDERS");
    await view.controller.handle({ type: "ready" });
    await view.controller.handle({
      type: "saveColumnSettings",
      semantic: {},
      keyColumns: ["ORDER_NO"],
    });
    const init = view.ofType("init").at(-1)?.view;
    expect(init?.columns.filter((c) => c.isKey).map((c) => c.name)).toEqual([
      "ORDER_NO",
    ]);
    const preview = view.ofType("preview").at(-1)?.preview;
    expect(preview?.ok && preview.sql).toContain("ORDER BY [ORDER_NO]");

    const table = withStore("ORDERS");
    await table.controller.handle({ type: "ready" });
    await table.controller.handle({
      type: "saveColumnSettings",
      semantic: {},
      keyColumns: ["STATUS"],
    });
    expect(table.saved).toEqual([{}]);
  });
});
