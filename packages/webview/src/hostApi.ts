// ホスト（拡張、または開発用ページの偽のホスト）とのやり取り

import type { FromWebview, ToWebview } from "@sql-editor-tool/host";

export type HostApi = {
  post(message: FromWebview): void;
  /** 戻り値を呼ぶと購読をやめる */
  subscribe(handler: (message: ToWebview) => void): () => void;
};

type VsCodeApi = { postMessage(message: unknown): void };
declare function acquireVsCodeApi(): VsCodeApi;

/** VS Code の Webview の中で使う */
export function vscodeHostApi(): HostApi {
  const vscode = acquireVsCodeApi();
  return {
    post: (message) => vscode.postMessage(message),
    subscribe(handler) {
      const listener = (event: MessageEvent<ToWebview>) => handler(event.data);
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
  };
}
