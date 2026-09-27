import { describe, expect, test, vi } from "vitest";
import { DemoSession } from "./demo/demoSession";
import type { ToResults } from "./resultsProtocol";
import {
  MAX_RESULT_TABS,
  ResultsController,
  type RunRequest,
  type RunStatement,
} from "./resultsView";

// デモのテーブル（架空）を使う
function setup() {
  const session = new DemoSession({ dialect: "mssql", chunkDelayMs: 0 });
  const messages: ToResults[] = [];
  const values = new Map<string, Record<string, string>>();
  const focus = vi.fn();
  const reveal = vi.fn();
  const controller = new ResultsController({
    post: (message) => messages.push(message),
    openSession: async () => session,
    settings: { maxRows: 100 },
    copyText: async () => {},
    savedValues: (source) => values.get(source),
    saveValues: (source, v) => values.set(source, v),
    saveConfig: async () => {},
    reveal,
    chooseConnection: () => {},
    focus,
    now: () => new Date(2026, 8, 27, 10, 0),
  });
  const tabs = () => messages.filter((m) => m.type === "tabs").at(-1);
  const tabMessages = (tabId: string) =>
    messages.flatMap((m) =>
      m.type === "tab" && m.tabId === tabId ? [m.message] : [],
    );
  /** 画面のタブの準備ができた（タブが ready を送った） */
  const ready = (tabId: string) =>
    controller.handle({ type: "tab", tabId, message: { type: "ready" } });
  return {
    controller,
    messages,
    tabs,
    tabMessages,
    ready,
    values,
    focus,
    reveal,
  };
}

const statement = (sql: string, line = 0): RunStatement => ({
  sql,
  start: 0,
  end: sql.length,
  line,
});

const request = (
  source: string,
  statements: RunStatement[],
  config: RunRequest["config"] = null,
): RunRequest => ({
  source,
  label: source.replace(/^.*\//, ""),
  statements,
  config,
  connection: { name: "デモ", dialect: "mssql", demo: true },
});

describe("ResultsController", () => {
  test("実行するとタブを作り、画面のタブの準備ができたら実行する", async () => {
    const { controller, tabs, tabMessages, ready } = setup();
    controller.run(
      request("file:///受注.sql", [statement("SELECT * FROM ORDERS", 11)]),
    );
    const list = tabs();
    expect(list?.tabs).toEqual([
      { id: "tab1", label: "受注.sql", detail: "受注.sql の 12 行目" },
    ]);
    expect(list?.active).toBe("tab1");
    // 準備ができるまでは実行しない（行が画面に届かないため）
    expect(tabMessages("tab1")).toEqual([]);
    await ready("tab1");
    const types = tabMessages("tab1").map((m) => m.type);
    expect(types).toContain("init");
    expect(types).toContain("columns");
    expect(
      tabMessages("tab1").find((m) => m.type === "queryDone"),
    ).toMatchObject({ rowCount: 100, truncated: true });
  });

  test("同じファイルでもう一度実行すると、前のタブを閉じて同じ位置に作る。文が複数なら番号を付ける", () => {
    const { controller, tabs } = setup();
    controller.run(
      request("file:///a.sql", [statement("SELECT * FROM ORDERS")]),
    );
    controller.run(
      request("file:///b.sql", [statement("SELECT * FROM ITEMS")]),
    );
    controller.run(
      request("file:///a.sql", [
        statement("SELECT * FROM ORDERS"),
        statement("SELECT * FROM CUSTOMERS", 3),
      ]),
    );
    expect(tabs()?.tabs.map((t) => [t.id, t.label])).toEqual([
      ["tab3", "a.sql (1)"],
      ["tab4", "a.sql (2)"],
      ["tab2", "b.sql"],
    ]);
    expect(tabs()?.active).toBe("tab3");
  });

  test("必須の入力欄が空なら実行せず、その入力欄にカーソルを置いてもらう。値は次の実行に使う", async () => {
    const { controller, tabMessages, ready, focus, values } = setup();
    const sql = "SELECT * FROM ORDERS WHERE CUST_CD = :得意先";
    controller.run(request("file:///q.sql", [statement(sql)]));
    await ready("tab1");
    expect(tabMessages("tab1").filter((m) => m.type === "focusParam")).toEqual([
      { type: "focusParam", name: "得意先" },
    ]);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(tabMessages("tab1").some((m) => m.type === "queryStarted")).toBe(
      false,
    );
    await controller.handle({
      type: "tab",
      tabId: "tab1",
      message: { type: "valuesChanged", values: { 得意先: "C00001" } },
    });
    expect(values.get("file:///q.sql")).toEqual({ 得意先: "C00001" });
    // 次の実行では、覚えた値で実行する
    controller.run(request("file:///q.sql", [statement(sql)]));
    await ready("tab2");
    expect(tabMessages("tab2").some((m) => m.type === "queryStarted")).toBe(
      true,
    );
  });

  test("ファイルの設定のコメント（入力欄の表示名など）を使う。update で作り直す", async () => {
    const { controller, tabMessages, ready } = setup();
    const sql = "SELECT * FROM ORDERS WHERE CUST_CD = :得意先";
    controller.run(
      request("file:///q.sql", [statement(sql)], {
        params: { 得意先: { label: "得意先コード", required: false } },
      }),
    );
    await ready("tab1");
    const init = () =>
      tabMessages("tab1")
        .filter((m) => m.type === "init")
        .at(-1);
    expect(init()).toMatchObject({
      view: { params: [{ name: "得意先", label: "得意先コード" }] },
    });
    controller.update(
      "file:///q.sql",
      { params: { 得意先: { label: "得意先" } } },
      null,
    );
    expect(init()).toMatchObject({
      view: { connection: null, params: [{ label: "得意先" }] },
    });
  });

  test("タブを閉じると右隣を前に出す。「SQL へ移動」はその文を見せる", async () => {
    const { controller, tabs, reveal } = setup();
    const first = statement("SELECT * FROM ORDERS", 2);
    controller.run(request("file:///a.sql", [first, statement("SELECT 1")]));
    await controller.handle({
      type: "tab",
      tabId: "tab1",
      message: { type: "editSql" },
    });
    expect(reveal).toHaveBeenCalledWith("file:///a.sql", first);
    await controller.handle({ type: "closeTab", tabId: "tab1" });
    expect(tabs()).toMatchObject({ active: "tab2" });
    await controller.handle({ type: "closeTab", tabId: "tab2" });
    expect(tabs()).toEqual({ type: "tabs", tabs: [], active: null });
  });

  test("エディタで前に出したファイルの結果のタブを前に出す", () => {
    const { controller, tabs } = setup();
    controller.run(request("file:///a.sql", [statement("SELECT 1")]));
    controller.run(request("file:///b.sql", [statement("SELECT 2")]));
    expect(tabs()?.active).toBe("tab2");
    controller.activate("file:///a.sql");
    expect(tabs()?.active).toBe("tab1");
    expect(controller.has("file:///c.sql")).toBe(false);
  });

  test("タブが上限を超えたら、古いものから閉じる", () => {
    const { controller, tabs } = setup();
    for (let i = 0; i <= MAX_RESULT_TABS; i += 1) {
      controller.run(request(`file:///${i}.sql`, [statement("SELECT 1")]));
    }
    const list = tabs()?.tabs ?? [];
    expect(list).toHaveLength(MAX_RESULT_TABS);
    expect(list[0]?.label).toBe("1.sql");
  });
});

describe("思わぬ例外（O-18）", () => {
  test("タブの処理で例外が起きても、黙って止まらずタブにエラーとして出す", async () => {
    const { controller, tabMessages, ready, focus } = setup();
    focus.mockImplementation(() => {
      throw new Error("パネルを開けません");
    });
    // 必須の入力欄が空なので、パネルにフォーカスを移そうとして例外になる
    controller.run(
      request("file:///受注.sql", [
        statement("SELECT * FROM ORDERS WHERE CUST_CD = :得意先"),
      ]),
    );
    await ready("tab1");
    expect(tabMessages("tab1").at(-1)).toEqual({
      type: "queryFailed",
      queryId: 0,
      message: "思わぬエラーで止まりました：パネルを開けません",
      cancelled: false,
    });
  });
});
