// 画面（データビュー・レポート・結果）の表示の設定。列見出しに出す名前（D-40）を VS Code の設定に持ち、
// すべての画面で同じにする。画面で切り替えたら設定に書き、設定が変わったら開いている画面すべてに送る

import type { HeaderMode, PrefsMessage } from "@sql-editor-tool/host";
import * as vscode from "vscode";

const HEADERS_SETTING = "logicalNames.headers";
const MODES: readonly HeaderMode[] = ["both", "logical", "physical"];

function headerMode(): HeaderMode {
  const value = vscode.workspace
    .getConfiguration("sqlEditorTool")
    .get<string>(HEADERS_SETTING, "both");
  return MODES.find((m) => m === value) ?? "both";
}

function prefsMessage(): PrefsMessage {
  return { type: "prefs", headerMode: headerMode() };
}

/**
 * 画面の設定のやり取りをつなぐ。画面の ready で今の設定を送り、setHeaderMode で設定に書く。
 * 戻り値は、設定が変わったときに送るのをやめるためのもの
 */
export function connectPrefs(webview: vscode.Webview): vscode.Disposable {
  return vscode.Disposable.from(
    webview.onDidReceiveMessage((message: { type?: string; mode?: string }) => {
      if (message.type === "ready") {
        void webview.postMessage(prefsMessage());
      } else if (message.type === "setHeaderMode") {
        const mode = MODES.find((m) => m === message.mode);
        if (mode && mode !== headerMode()) {
          void vscode.workspace
            .getConfiguration("sqlEditorTool")
            .update(HEADERS_SETTING, mode, vscode.ConfigurationTarget.Global);
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`sqlEditorTool.${HEADERS_SETTING}`)) {
        void webview.postMessage(prefsMessage());
      }
    }),
  );
}
