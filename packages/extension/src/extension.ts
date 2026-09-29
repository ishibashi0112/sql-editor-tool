// VS Code 拡張のエントリ

import * as vscode from "vscode";
import { ConnectionStore, promptConnection } from "./connections";
import { openDataView } from "./dataViewPanel";
import { DIFF_CAMERA_VIEW_ID, DiffCameraPanel } from "./diffCameraPanel";
import { carryOverUntitled } from "./fileSettings";
import { LogicalNameDecorations } from "./logicalNameDecorations";
import { RESULTS_VIEW_ID, ResultsPanel } from "./resultsPanel";
import { TableSearchView } from "./searchView";
import { SessionManager } from "./sessions";
import { exportSettings, importSettings } from "./settingsTransfer";
import { SqlEditing } from "./sqlEditing";
import { SqlFormatting } from "./sqlFormatting";
import { SqlGeneration } from "./sqlGeneration";
import { ConnectionTree, type TreeNode } from "./tree";

let sessions: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConnectionStore(context);
  sessions = new SessionManager(store, context.extensionUri);
  const tree = new ConnectionTree(store, sessions);
  const manager = sessions;
  const search = new TableSearchView(context.extensionUri, store, manager);
  const editing = new SqlEditing(store, manager, context.globalState);
  // 実行や撮影の経過（「出力」の SQL Editor Tool）。SQL の本文・入力した値・パスワードは書かない
  const output = vscode.window.createOutputChannel("SQL Editor Tool", {
    log: true,
  });
  // .sql の実行と「SQL の結果」のパネル（D-41）
  const results = new ResultsPanel({
    extensionUri: context.extensionUri,
    store,
    sessions: manager,
    editing,
    state: context.globalState,
    output,
  });
  // 差分カメラ（D-47）
  const cameras = new DiffCameraPanel({
    extensionUri: context.extensionUri,
    store,
    sessions: manager,
    editing,
    state: context.globalState,
    output,
  });
  context.subscriptions.push(
    store,
    manager,
    editing,
    // .sql の論理名の見た目（D-42）
    new LogicalNameDecorations(editing),
    // .sql の整形（D-45）
    new SqlFormatting(editing, context),
    // テーブルから SQL を生成（D-49）
    new SqlGeneration({ store, editing, state: context.globalState }),
    // 名前のないファイルに覚えた接続などを、保存したファイルに引き継ぐ
    carryOverUntitled(context.globalState, () => editing.refresh()),
    vscode.window.createTreeView("sqlEditorTool.connections", {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
    vscode.window.registerWebviewViewProvider("sqlEditorTool.search", search, {
      // 入力中の文字と結果を、サイドバーを切り替えても保つ
      webviewOptions: { retainContextWhenHidden: true },
    }),
    output,
    cameras,
    vscode.window.registerWebviewViewProvider(DIFF_CAMERA_VIEW_ID, cameras, {
      // 撮った状態の表示を、サイドバーを切り替えても保つ
      webviewOptions: { retainContextWhenHidden: true },
    }),
    results,
    vscode.window.registerWebviewViewProvider(RESULTS_VIEW_ID, results, {
      // 取得した行を、ターミナルなどに切り替えても保つ
      webviewOptions: { retainContextWhenHidden: true },
    }),
    store.onDidChange(() => {
      tree.refresh();
      search.update();
    }),
    manager.onDidChange(() => {
      tree.refresh();
      search.update();
    }),

    vscode.commands.registerCommand("sqlEditorTool.exportSettings", () =>
      exportSettings(context, store),
    ),
    vscode.commands.registerCommand("sqlEditorTool.importSettings", () =>
      importSettings(context, store, () => cameras.reload()),
    ),

    vscode.commands.registerCommand("sqlEditorTool.addConnection", async () => {
      const added = await promptConnection();
      if (added) await store.add(added.profile, added.password);
    }),

    vscode.commands.registerCommand(
      "sqlEditorTool.removeConnection",
      async (node?: TreeNode) => {
        if (node?.kind !== "connection") return;
        const answer = await vscode.window.showWarningMessage(
          `接続「${node.profile.name}」を削除しますか？（保存したパスワードも削除します）`,
          { modal: true },
          "削除",
        );
        if (answer !== "削除") return;
        await manager.close(node.profile.id);
        await store.remove(node.profile.id);
      },
    ),

    vscode.commands.registerCommand(
      "sqlEditorTool.disconnect",
      async (node?: TreeNode) => {
        if (node?.kind !== "connection") return;
        await manager.close(node.profile.id);
        editing.clear(node.profile.id);
      },
    ),

    vscode.commands.registerCommand("sqlEditorTool.refresh", () => {
      tree.refresh();
      search.reload();
      editing.clear();
    }),

    vscode.commands.registerCommand(
      "sqlEditorTool.openTable",
      async (node?: TreeNode) => {
        if (node?.kind !== "object") return;
        try {
          const session = await manager.get(node.profile);
          openDataView({
            extensionUri: context.extensionUri,
            connectionName: node.profile.name,
            session,
            table: node.table,
            logicalName: node.logicalName,
            demo: node.profile.driver === "demo",
            state: context.globalState,
          });
        } catch (error) {
          void vscode.window.showErrorMessage(
            `「${node.profile.name}」に接続できませんでした：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
  );
}

export async function deactivate(): Promise<void> {
  await sessions?.closeAll();
}
