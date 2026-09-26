// 開発用ページ：レポートの画面を VS Code の外で確かめる。ホスト側の制御とデモ接続を同じページの中で動かす。
// URL のクエリ：?maxRows=5000&connection=none（接続を選んでいない状態）

import "@ishibashi0112/spreadsheet-grid/style.css";
import "../src/styles.css";
import { writeReportConfig } from "@sql-editor-tool/core";
import {
  DemoSession,
  type FromReport,
  type ReportConnection,
  ReportController,
  type ToReport,
} from "@sql-editor-tool/host";
import { createRoot } from "react-dom/client";
import type { HostApi } from "../src/hostApi";
import { ReportApp } from "../src/report/ReportApp";

const query = new URLSearchParams(location.search);
// デモのテーブル ORDERS を使う架空のレポート。
// 開始日と数量は種類を書いていないので、デモ接続の推定（名前から決める）で yyyymmdd の日付と数値になる
let text = `/* @report
{
  "params": {
    "開始日": { "label": "受注日（から）", "default": "月初-1か月" },
    "得意先": {
      "type": "select",
      "required": false,
      "options": "SELECT [CUST_CD], [CUST_NAME] FROM [APP].[CUSTOMERS] ORDER BY [CUST_CD]"
    },
    "数量": { "required": false }
  }
}
*/
SELECT *
FROM [APP].[ORDERS]
WHERE [ORDER_YMD] >= :開始日
  AND (:得意先 IS NULL OR [CUST_CD] = :得意先)
  AND (:数量 IS NULL OR [QTY] >= :数量)
ORDER BY [ORDER_NO]`;

const demo: ReportConnection = { name: "デモ", dialect: "mssql", demo: true };
let connection: ReportConnection | null =
  query.get("connection") === "none" ? null : demo;

const handlers = new Set<(message: ToReport) => void>();
const controller: ReportController = new ReportController({
  title: "受注一覧",
  text,
  connection,
  openSession: async () => new DemoSession({ dialect: "mssql" }),
  settings: { maxRows: Number(query.get("maxRows") ?? 100000) },
  // postMessage と同じく、非同期に届ける
  post: (message) => {
    setTimeout(() => {
      for (const handler of handlers) handler(message);
    });
  },
  copyText: async (sql) => console.info(sql),
  saveConfig: async (config) => {
    text = writeReportConfig(text, config);
    console.info(text);
    controller.update(text, connection);
  },
  editSql: () => console.info("SQL を編集"),
  chooseConnection: () => {
    connection = demo;
    controller.update(text, connection);
  },
});

const api: HostApi<FromReport, ToReport> = {
  post: (message) => {
    setTimeout(() => void controller.handle(message));
  },
  subscribe(handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<ReportApp api={api} />);
