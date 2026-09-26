// ホスト（拡張、または開発用ページの偽のホスト）とのやり取り

import type { FromWebview, ToWebview } from "@sql-editor-tool/host";

/** From は画面 → ホスト、To はホスト → 画面のメッセージ。既定はデータビューのもの */
export type HostApi<From = FromWebview, To = ToWebview> = {
  post(message: From): void;
  /** 戻り値を呼ぶと購読をやめる */
  subscribe(handler: (message: To) => void): () => void;
};

type VsCodeApi = { postMessage(message: unknown): void };
declare function acquireVsCodeApi(): VsCodeApi;

/** VS Code の Webview の中で使う（1 つの Webview で 1 回だけ呼べる） */
export function vscodeHostApi<From = FromWebview, To = ToWebview>(): HostApi<
  From,
  To
> {
  const vscode = acquireVsCodeApi();
  return {
    post: (message) => vscode.postMessage(message),
    subscribe(handler) {
      const listener = (event: MessageEvent<To>) => handler(event.data);
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
  };
}
