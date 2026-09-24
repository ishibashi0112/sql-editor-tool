// 開発用ページ：VS Code の外（ブラウザ）で画面を確かめる。ホスト側の制御とデモ接続を、同じページの中で動かす。
// URL のクエリで切り替える：?table=ORDERS&dialect=oracle&maxRows=5000

import "@ishibashi0112/spreadsheet-grid/style.css";
import "../src/styles.css";
import type { DialectName } from "@sql-editor-tool/core";
import {
  DataViewController,
  DemoSession,
  type FromWebview,
  type ToWebview,
} from "@sql-editor-tool/host";
import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import type { HostApi } from "../src/hostApi";

const query = new URLSearchParams(location.search);
const dialect: DialectName =
  query.get("dialect") === "oracle" ? "oracle" : "mssql";

const handlers = new Set<(message: ToWebview) => void>();
const controller = new DataViewController({
  session: new DemoSession({ dialect }),
  table: { schema: "APP", name: query.get("table") ?? "ORDERS" },
  settings: {
    maxRows: Number(query.get("maxRows") ?? 100000),
    filterOptionsLimit: Number(query.get("filterOptionsLimit") ?? 10000),
  },
  demo: true,
  // postMessage と同じく、非同期に届ける
  post: (message) => {
    setTimeout(() => {
      for (const handler of handlers) handler(message);
    });
  },
  copyText: async (text) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    console.info(text);
  },
});

const api: HostApi = {
  post: (message: FromWebview) => {
    setTimeout(() => void controller.handle(message));
  },
  subscribe(handler) {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<App api={api} />);
