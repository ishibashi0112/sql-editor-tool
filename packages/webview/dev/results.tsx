// 開発用ページ：「SQL の結果」のパネル（D-41）を VS Code の外で確かめる。上のテキストの欄をエディタの代わりにし、
// Ctrl+Enter でカーソルの文（範囲を選んでいればその部分）を実行する。ホスト側の制御とデモ接続を同じページの中で動かす

import "@ishibashi0112/spreadsheet-grid/style.css";
import "../src/styles.css";
import {
  getDialect,
  parseReportConfig,
  splitStatements,
  statementAt,
  writeReportConfig,
} from "@sql-editor-tool/core";
import {
  DemoSession,
  describeResultColumns,
  type FromResults,
  type ReportConnection,
  type ReportFormValues,
  ResultsController,
  SchemaCache,
  type ToResults,
} from "@sql-editor-tool/host";
import { createRoot } from "react-dom/client";
import type { HostApi } from "../src/hostApi";
import { ResultsApp } from "../src/results/ResultsApp";

const SOURCE = "file:///受注の確認.sql";
const editor = document.getElementById("editor") as HTMLTextAreaElement;
// デモのテーブル（架空）
editor.value = `-- Ctrl+Enter でカーソルの文を実行（範囲を選べばその部分）
SELECT o.ORDER_NO, o.LINE_NO, o.CUST_CD, c.CUST_NAME, o.QTY, o.ORDER_YMD
FROM APP.ORDERS o
JOIN APP.CUSTOMERS c ON c.CUST_CD = o.CUST_CD;

SELECT * FROM APP.ITEMS WHERE CATEGORY = :分類

SELECT * FROM APP.V_OPEN_ORDERS`;

const connection: ReportConnection = {
  name: "デモ",
  dialect: "mssql",
  demo: true,
};
const session = new DemoSession({ dialect: "mssql" });
const cache = new SchemaCache(async () => session);
const values = new Map<string, ReportFormValues>();

const handlers = new Set<(message: ToResults) => void>();
const controller = new ResultsController({
  // postMessage と同じく、非同期に届ける
  post: (message) => {
    setTimeout(() => {
      for (const handler of handlers) handler(message);
    });
  },
  openSession: async () => session,
  settings: { maxRows: 100000 },
  copyText: async (sql) => console.info(sql),
  savedValues: (source) => values.get(source),
  saveValues: (source, v) => values.set(source, v),
  saveConfig: async (source, config) => {
    editor.value = writeReportConfig(editor.value, config);
    controller.update(source, config, connection);
  },
  reveal: (_source, statement) => {
    editor.focus();
    editor.setSelectionRange(statement.start, statement.end);
  },
  chooseConnection: () => console.info("接続を選ぶ"),
  describeColumns: (_source, text, names) =>
    describeResultColumns({ dialect: "mssql", text, cache, names }),
  focus: () => {},
});

function run(): void {
  const text = editor.value;
  const dialect = getDialect("mssql");
  const { selectionStart, selectionEnd } = editor;
  const selected = selectionStart !== selectionEnd;
  const base = selected ? selectionStart : 0;
  const target = selected ? text.slice(selectionStart, selectionEnd) : text;
  const all = splitStatements(dialect, target);
  const statements = selected
    ? all
    : [statementAt(all, selectionStart)].filter((s) => s !== undefined);
  if (statements.length === 0) return;
  const config = parseReportConfig(text).config;
  controller.run({
    source: SOURCE,
    label: "受注の確認.sql",
    statements: statements.map((s) => ({
      sql: target.slice(s.start, s.end),
      start: base + s.start,
      end: base + s.end,
      line: text.slice(0, base + s.start).split("\n").length - 1,
    })),
    config: Object.keys(config).length > 0 ? config : null,
    connection,
  });
}

editor.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    run();
  }
});

const api: HostApi<FromResults, ToResults> = {
  post: (message) => {
    setTimeout(() => void controller.handle(message));
  },
  subscribe(handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<ResultsApp api={api} />);
