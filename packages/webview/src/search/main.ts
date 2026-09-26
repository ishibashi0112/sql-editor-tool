// VS Code のサイドバーの Webview（テーブル検索）に読み込むエントリ

import "./search.css";
import type { FromSearchView, ToSearchView } from "@sql-editor-tool/host";
import { mountSearchView } from "./view";

type VsCodeApi = { postMessage(message: FromSearchView): void };
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById("root");
if (root) {
  mountSearchView(root, {
    post: (message) => vscode.postMessage(message),
    subscribe(handler) {
      const listener = (event: MessageEvent<ToSearchView>) =>
        handler(event.data);
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
  });
}
