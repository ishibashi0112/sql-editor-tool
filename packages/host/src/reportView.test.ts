import type {
  DbParamGuess,
  ReportConfig,
  ReportParamProbe,
} from "@sql-editor-tool/core";
import { describe, expect, test, vi } from "vitest";
import { DemoSession } from "./demo/demoSession";
import type { ToReport } from "./reportProtocol";
import {
  OPTIONS_LIMIT,
  type ReportConnection,
  ReportController,
  toViewColumns,
} from "./reportView";
import { abortError, type DbSession, type QueryRequest } from "./session";

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
  options: {
    connection?: ReportConnection | null;
    text?: string;
    initialValues?: Record<string, string>;
    /** DB の推定の代わり（なければ推定しない DB） */
    guess?: DbSession["guessParamTypes"];
    /** DB の問い合わせの代わり（なければデモ接続） */
    query?: DbSession["query"];
  } = {},
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
      return (options.query ?? demo.query.bind(demo))(request, handlers);
    },
    close: async () => {},
    ...(options.guess ? { guessParamTypes: options.guess } : {}),
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
    initialValues: options.initialValues,
    // ローカル時刻の 2026-09-26
    now: () => new Date(2026, 8, 26, 10, 0),
  });
  const ofType = <T extends ToReport["type"]>(type: T) =>
    messages.filter(
      (m): m is Extract<ToReport, { type: T }> => m.type === type,
    );
  const lastPreview = () => ofType("preview").at(-1)?.preview;
  const lastInit = () => ofType("init").at(-1)?.view;
  return {
    controller,
    requests,
    saved,
    chooseConnection,
    ofType,
    lastPreview,
    lastInit,
  };
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

describe("既定値（相対の日付、D-32・D-33）", () => {
  const text = `/* @report
{ "params": {
  "開始": { "type": "ymd", "default": "月初-1か月" },
  "終了": { "type": "date", "default": "2026-09-30" },
  "得意先": { "default": "C00001" }
} }
*/
SELECT * FROM ORDERS WHERE ORDER_YMD BETWEEN :開始 AND :終了 AND CUST_CD = :得意先`;

  test("開いたときは、相対の既定値を持つ入力欄だけ、前回の値を使わずに計算する", async () => {
    const { controller, lastInit } = setup({
      text,
      initialValues: { 開始: "2026-01-01", 終了: "2026-01-31", 得意先: "C9" },
    });
    await controller.handle({ type: "ready" });
    expect(lastInit()?.values).toEqual({
      開始: "2026-08-01",
      終了: "2026-01-31",
      得意先: "C9",
    });
  });

  test("前回の値がなければ既定値。開いたままの書き換えでは、入力した値を残す", async () => {
    const { controller, lastInit } = setup({ text });
    await controller.handle({ type: "ready" });
    expect(lastInit()?.values).toEqual({
      開始: "2026-08-01",
      終了: "2026-09-30",
      得意先: "C00001",
    });
    await controller.handle({
      type: "valuesChanged",
      values: { 開始: "2026-07-01", 終了: "2026-09-30", 得意先: "C00001" },
    });
    controller.update(`${text} ORDER BY 1`, connection);
    expect(lastInit()?.values.開始).toBe("2026-07-01");
  });
});

describe("入力欄の種類の推定（D-35）", () => {
  const text = `/* @report
{ "params": { "得意先": { "type": "text" } } }
*/
SELECT * FROM ORDERS
WHERE ORDER_YMD >= :開始日
  AND (:数量 IS NULL OR QTY = :数量)
  AND CUST_CD = :得意先`;

  test("種類を設定していない入力欄を推定し、入力欄と実行に使う（設定した種類はそのまま）", async () => {
    const guess = vi.fn(
      async (
        _probe: ReportParamProbe,
      ): Promise<Record<string, DbParamGuess>> => ({
        p1: { kind: "string", length: 4000 },
        p3: { kind: "number" },
        p4: { kind: "number" },
      }),
    );
    const { controller, lastInit, lastPreview } = setup({ text, guess });
    await vi.waitFor(() =>
      expect(
        lastInit()?.params.map((p) => [p.name, p.type, p.guessed]),
      ).toEqual([
        ["開始日", "ymd", true],
        ["数量", "number", true],
        ["得意先", "text", false],
      ]),
    );
    expect(guess).toHaveBeenCalledTimes(1);
    expect(guess.mock.calls[0]?.[0].sql).toContain(
      "(@p2 IS NULL OR QTY = @p3)",
    );
    await controller.handle({
      type: "valuesChanged",
      values: { 開始日: "2026-09-01", 数量: "1,000", 得意先: "C1" },
    });
    expect(lastPreview()).toMatchObject({
      ok: true,
      literalSql: expect.stringContaining("ORDER_YMD >= '20260901'"),
    });
    expect(lastPreview()).toMatchObject({
      literalSql: expect.stringContaining("(1000 IS NULL OR QTY = 1000)"),
    });
  });

  test("同じ接続・同じ SQL では推定し直さない。SQL を変えたら推定し直す", async () => {
    const guess = vi.fn(async () => ({}));
    const { controller } = setup({ text, guess });
    await vi.waitFor(() => expect(guess).toHaveBeenCalledTimes(1));
    controller.update(text, connection);
    await Promise.resolve();
    expect(guess).toHaveBeenCalledTimes(1);
    controller.update(`${text} AND ITEM_CD = :品目`, connection);
    await vi.waitFor(() => expect(guess).toHaveBeenCalledTimes(2));
  });

  test("接続を切り替えたら、前の接続で推定した種類は使わない", async () => {
    const guess = vi.fn(async () => ({
      p1: { kind: "number" } as const,
    }));
    const { controller, lastInit } = setup({
      text: "SELECT * FROM ORDERS WHERE QTY = :数量",
      guess,
    });
    await vi.waitFor(() => expect(lastInit()?.params[0]?.type).toBe("number"));
    controller.update("SELECT * FROM ORDERS WHERE QTY = :数量", null);
    expect(lastInit()?.params[0]?.type).toBe("text");
  });

  test("すべての入力欄に種類を設定してあれば、DB に問い合わせない", async () => {
    const guess = vi.fn(async () => ({}));
    const { controller } = setup({
      text: `/* @report
{ "params": { "a": { "type": "text" } } }
*/
SELECT * FROM ORDERS WHERE CUST_CD = :a`,
      guess,
    });
    await controller.handle({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(guess).not.toHaveBeenCalled();
  });

  test("推定の後、既定値が相対の日付なら日付に計算する", async () => {
    const guess = vi.fn(async () => ({
      p1: { kind: "string", length: 8 } as const,
    }));
    const { lastInit } = setup({
      text: `/* @report
{ "params": { "開始日": { "default": "今日" } } }
*/
SELECT * FROM ORDERS WHERE ORDER_YMD >= :開始日`,
      guess,
    });
    await vi.waitFor(() =>
      expect(lastInit()?.values).toEqual({ 開始日: "2026-09-26" }),
    );
  });
});

describe("選択肢（D-34）", () => {
  const withOptions = (options: string) => `/* @report
{ "params": { "得意先": { "type": "select", "options": ${JSON.stringify(options)} } } }
*/
SELECT * FROM ORDERS WHERE CUST_CD = :得意先`;

  test("候補の SQL の 1 列目を値、2 列目を表示名にして送る", async () => {
    const { controller, ofType, requests } = setup({
      text: withOptions("SELECT CUST_CD, CUST_NAME FROM CUSTOMERS"),
    });
    await vi.waitFor(() =>
      expect(ofType("options").at(-1)?.state.status).toBe("ok"),
    );
    const state = ofType("options").at(-1)?.state;
    expect(state?.status === "ok" && state.options[0]).toEqual({
      value: "C00001",
      label: expect.any(String),
    });
    expect(state?.status === "ok" && state.truncated).toBe(false);
    expect(ofType("options")[0]?.state).toEqual({ status: "loading" });
    expect(requests[0]?.sql).toBe("SELECT CUST_CD, CUST_NAME FROM CUSTOMERS");
    // 開き直した画面（ready）にも、取得済みの候補を渡す
    await controller.handle({ type: "ready" });
    expect(ofType("init").at(-1)?.view.options.得意先?.status).toBe("ok");
  });

  test("上限を超えたら、残りは取らずに打ち切る。同じ値は 1 つにまとめる", async () => {
    let sent = 0;
    const { ofType } = setup({
      text: withOptions("SELECT CODE, NAME FROM MANY"),
      query: async (_, handlers) => {
        handlers.onColumns([]);
        handlers.onRows([
          ["A", "重複"],
          ["A", "重複"],
          [null, "空"],
        ]);
        for (let i = 0; i < 5; i += 1) {
          if (handlers.signal.aborted) throw abortError();
          const rows = Array.from({ length: 4000 }, (_, j) => [
            `K${sent + j}`,
            null,
          ]);
          sent += rows.length;
          handlers.onRows(rows);
        }
      },
    });
    await vi.waitFor(() =>
      expect(ofType("options").at(-1)?.state.status).toBe("ok"),
    );
    const state = ofType("options").at(-1)?.state;
    // 空の値を除き、同じ値をまとめた後の件数（取った行は上限 + 1 行を超えたところで止める）
    expect(state?.status === "ok" && state.options.length).toBe(
      OPTIONS_LIMIT - 2,
    );
    expect(state?.status === "ok" && state.options[1]).toEqual({
      value: "K0",
      label: "",
    });
    expect(state?.status === "ok" && state.truncated).toBe(true);
    expect(sent).toBe(12000);
  });

  test("候補の SQL の誤りは、その入力欄のエラーとして送る。同じ SQL なら取り直さない", async () => {
    const { controller, ofType, requests } = setup({
      text: withOptions("SELECT CUST_CD FROM CUSTOMERS WHERE X = :x"),
    });
    await vi.waitFor(() =>
      expect(ofType("options").at(-1)?.state).toEqual({
        status: "error",
        message:
          "候補を取れませんでした：候補の SQL には :名前 は使えません（:x）",
      }),
    );
    const count = ofType("options").length;
    controller.update(
      withOptions("SELECT CUST_CD FROM CUSTOMERS WHERE X = :x"),
      connection,
    );
    expect(ofType("options")).toHaveLength(count);
    expect(requests).toHaveLength(0);
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
