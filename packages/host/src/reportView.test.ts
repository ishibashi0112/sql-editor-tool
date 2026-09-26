import type { ReportConfig } from "@sql-editor-tool/core";
import { describe, expect, test, vi } from "vitest";
import { DemoSession } from "./demo/demoSession";
import type { ToReport } from "./reportProtocol";
import {
  type ReportConnection,
  ReportController,
  toViewColumns,
} from "./reportView";
import type { DbSession, QueryRequest } from "./session";

// デモのテーブル ORDERS を使う架空のレポート
const TEXT = `/* @report
{ "params": { "得意先": { "label": "得意先コード" }, "件数": { "type": "number", "required": false } } }
*/
SELECT * FROM [APP].[ORDERS] WHERE [CUST_CD] = :得意先 ORDER BY [ORDER_NO]`;

const connection: ReportConnection = {
  name: "デモ",
  dialect: "mssql",
  demo: true,
};

function setup(
  options: { connection?: ReportConnection | null; text?: string } = {},
) {
  const demo = new DemoSession({ dialect: "mssql", chunkDelayMs: 0 });
  const requests: QueryRequest[] = [];
  const session: DbSession = {
    ...demo,
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
  const messages: ToReport[] = [];
  const saved: ReportConfig[] = [];
  const chooseConnection = vi.fn();
  const controller = new ReportController({
    title: "受注",
    text: options.text ?? TEXT,
    connection:
      options.connection === undefined ? connection : options.connection,
    openSession: async () => session,
    settings: { maxRows: 100 },
    post: (message) => messages.push(message),
    copyText: async () => {},
    saveConfig: async (config) => {
      saved.push(config);
    },
    editSql: () => {},
    chooseConnection,
  });
  const ofType = <T extends ToReport["type"]>(type: T) =>
    messages.filter(
      (m): m is Extract<ToReport, { type: T }> => m.type === type,
    );
  const lastPreview = () => ofType("preview").at(-1)?.preview;
  return { controller, requests, saved, chooseConnection, ofType, lastPreview };
}

describe("ReportController", () => {
  test("ready で入力欄（設定の表示名・種類）と SQL プレビューを送る", async () => {
    const { controller, ofType, lastPreview } = setup();
    await controller.handle({ type: "ready" });
    const init = ofType("init")[0]?.view;
    expect(init?.params.map((p) => [p.name, p.label, p.type])).toEqual([
      ["得意先", "得意先コード", "text"],
    ]);
    expect(init?.values).toEqual({ 得意先: "" });
    // 必須の入力欄が空なので、プレビューはその旨を出す
    expect(lastPreview()).toMatchObject({
      ok: false,
      message: "「得意先コード」を入力してください",
    });
  });

  test("値を入れるとプレビューが SQL になり、実行すると列と行を送る", async () => {
    const { controller, ofType, requests, lastPreview } = setup();
    await controller.handle({ type: "ready" });
    await controller.handle({
      type: "valuesChanged",
      values: { 得意先: "C00027" },
    });
    expect(lastPreview()).toMatchObject({
      ok: true,
      literalSql:
        "SELECT * FROM [APP].[ORDERS] WHERE [CUST_CD] = N'C00027' ORDER BY [ORDER_NO]",
    });
    await controller.handle({ type: "execute", mode: "all" });
    expect(requests[0]?.sql).toBe(
      "SELECT * FROM [APP].[ORDERS] WHERE [CUST_CD] = @p1 ORDER BY [ORDER_NO]",
    );
    expect(ofType("columns")[0]?.columns.map((c) => c.name)).toContain(
      "CUST_CD",
    );
    expect(ofType("rows").flatMap((m) => m.rows)).toHaveLength(100);
    expect(ofType("queryDone")[0]).toMatchObject({ truncated: true });
  });

  test("画面の絞り込みで取り直すときは、SQL を包んで WHERE を足す（ORDER BY は外す）", async () => {
    const { controller, requests, ofType } = setup();
    await controller.handle({ type: "ready" });
    await controller.handle({
      type: "valuesChanged",
      values: { 得意先: "C1" },
    });
    await controller.handle({ type: "execute", mode: "all" });
    const filters = { STATUS: { kind: "set", values: ["10"] } } as const;
    await controller.handle({
      type: "conditionsChanged",
      filters: { ...filters },
      sort: [{ columnKey: "QTY", direction: "desc" }],
    });
    await controller.handle({ type: "execute", mode: "filtered" });
    expect(requests[1]?.sql).toBe(
      [
        "SELECT TOP (@p1) *",
        "FROM (",
        "SELECT * FROM [APP].[ORDERS] WHERE [CUST_CD] = @p2",
        ") base_query",
        "WHERE [STATUS] = @p3",
        "ORDER BY [QTY] DESC",
      ].join("\n"),
    );
    expect(ofType("queryStarted")[1]?.filters).toEqual(filters);
  });

  test("接続を選んでいなければ、実行の代わりに接続を選んでもらう", async () => {
    const { controller, chooseConnection, lastPreview, requests } = setup({
      connection: null,
    });
    await controller.handle({ type: "ready" });
    expect(lastPreview()).toMatchObject({
      ok: false,
      message: "実行する接続を選んでください",
    });
    await controller.handle({ type: "execute", mode: "all" });
    expect(chooseConnection).toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  test("入力欄の設定を保存すると、ほかの設定（接続名）を残して書く", async () => {
    const text = `/* @report
{ "connection": "基幹" }
*/
SELECT * FROM ORDERS WHERE CUST_CD = :c`;
    const { controller, saved } = setup({ text });
    await controller.handle({
      type: "saveParams",
      params: { c: { label: "得意先", type: "text", required: false } },
    });
    expect(saved[0]).toEqual({
      connection: "基幹",
      params: { c: { label: "得意先", type: "text", required: false } },
    });
  });

  test("ファイルが書き換わっても、同じ名前の入力欄の値は残す", async () => {
    const { controller, ofType } = setup();
    await controller.handle({
      type: "valuesChanged",
      values: { 得意先: "C9" },
    });
    controller.update(
      "SELECT * FROM ORDERS WHERE CUST_CD = :得意先 AND ITEM_CD = :品目",
      connection,
    );
    expect(ofType("init").at(-1)?.view.values).toEqual({
      得意先: "C9",
      品目: "",
    });
  });
});

describe("toViewColumns", () => {
  test("名前のない列と重複した列名は、画面の列キーが重ならないようにする", () => {
    const type = { kind: "number", precision: null, scale: null } as const;
    expect(
      toViewColumns([
        { name: "ID", type },
        { name: "", type },
        { name: "ID", type },
      ]).map((c) => c.name),
    ).toEqual(["ID", "（列 2）", "ID (2)"]);
  });
});
