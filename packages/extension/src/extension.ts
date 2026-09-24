// VS Code 拡張のエントリ

import * as vscode from "vscode";
import { ConnectionStore, promptConnection } from "./connections";
import { openDataView } from "./dataViewPanel";
import { SessionManager } from "./sessions";
import { ConnectionTree, type TreeNode } from "./tree";

let sessions: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConnectionStore(context);
  sessions = new SessionManager(store);
  const tree = new ConnectionTree(store, sessions);
  const manager = sessions;

  context.subscriptions.push(
    store,
    manager,
    vscode.window.createTreeView("sqlEditorTool.connections", {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
    store.onDidChange(() => tree.refresh()),
    manager.onDidChange(() => tree.refresh()),

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
        if (node?.kind === "connection") await manager.close(node.profile.id);
      },
    ),

    vscode.commands.registerCommand("sqlEditorTool.refresh", () =>
      tree.refresh(),
    ),

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
            demo: node.profile.driver === "demo",
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
