// データビューの Webview パネル。制御は host の DataViewController に任せ、ここは VS Code とのつなぎだけ

import { randomBytes } from "node:crypto";
import type { TableRef, TableSettings } from "@sql-editor-tool/core";
import {
  DataViewController,
  type DataViewSettings,
  type DbSession,
  type FromWebview,
} from "@sql-editor-tool/host";
import * as vscode from "vscode";

export type OpenDataViewInput = {
  extensionUri: vscode.Uri;
  connectionName: string;
  session: DbSession;
  table: TableRef;
  demo: boolean;
  /** 列の設定（D-36）を保存する場所 */
  state: vscode.Memento;
};

const TABLE_SETTINGS_KEY = "sqlEditorTool.tableSettings";

/** 列の設定は、接続名・スキーマ・テーブルごとに持つ（接続の ID は PC ごとに違うので、レポートと同じく名前で結び付ける） */
function tableSettingsKey(connectionName: string, table: TableRef): string {
  return JSON.stringify([connectionName, table.schema, table.name]);
}

export function openDataView(input: OpenDataViewInput): void {
  const { extensionUri, session, table, state } = input;
  const settingsKey = tableSettingsKey(input.connectionName, table);
  const allSettings = () =>
    state.get<Record<string, TableSettings>>(TABLE_SETTINGS_KEY, {});
  const webviewRoot = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const panel = vscode.window.createWebviewPanel(
    "sqlEditorTool.dataView",
    table.name,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      // 取得した行を、タブを切り替えても保つ
      retainContextWhenHidden: true,
      localResourceRoots: [webviewRoot],
    },
  );
  panel.webview.html = html(panel.webview, webviewRoot);

  const controller = new DataViewController({
    session,
    table,
    settings: readSettings(),
    demo: input.demo,
    post: (message) => void panel.webview.postMessage(message),
    copyText: async (text) => {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.setStatusBarMessage("SQL をコピーしました", 3000);
    },
    tableSettings: {
      load: () => {
        const all = allSettings();
        return Object.hasOwn(all, settingsKey) ? all[settingsKey] : undefined;
      },
      save: async (settings) => {
        await state.update(TABLE_SETTINGS_KEY, {
          ...allSettings(),
          [settingsKey]: settings,
        });
      },
    },
  });
  const subscription = panel.webview.onDidReceiveMessage(
    (message: FromWebview) => {
      controller.handle(message).catch((error: unknown) => {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
      });
    },
  );
  panel.onDidDispose(() => {
    subscription.dispose();
    controller.dispose();
  });
}

function readSettings(): DataViewSettings {
  const config = vscode.workspace.getConfiguration("sqlEditorTool");
  return {
    maxRows: config.get<number>("maxRows", 100000),
  };
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "main.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "main.css"));
  // style-src の 'unsafe-inline' は、グリッドが列幅などを style 属性で当てるため
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join("; ");
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${style}" />
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}
