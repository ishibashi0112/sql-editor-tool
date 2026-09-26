// VS Code 拡張のエントリ

import * as vscode from "vscode";
import { ConnectionStore, promptConnection } from "./connections";
import { openDataView } from "./dataViewPanel";
import { ReportPanels } from "./reportPanel";
import {
  chooseReportsFolder,
  createReport,
  listReports,
  RecentReports,
  reportsFolder,
} from "./reports";
import { type ReportNode, ReportTree } from "./reportTree";
import { TableSearchView } from "./searchView";
import { SessionManager } from "./sessions";
import { ConnectionTree, type TreeNode } from "./tree";

let sessions: SessionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConnectionStore(context);
  sessions = new SessionManager(store, context.extensionUri);
  const tree = new ConnectionTree(store, sessions);
  const manager = sessions;
  const search = new TableSearchView(context.extensionUri, store, manager);
  const recent = new RecentReports(context.globalState);
  const reportTree = new ReportTree();
  const reports = new ReportPanels({
    extensionUri: context.extensionUri,
    store,
    sessions: manager,
    recent,
    state: context.globalState,
  });
  const openReport = (uri: vscode.Uri) =>
    reports.open(uri).catch((error: unknown) => {
      void vscode.window.showErrorMessage(
        `レポートを開けませんでした：${error instanceof Error ? error.message : String(error)}`,
      );
    });

  context.subscriptions.push(
    store,
    manager,
    vscode.window.createTreeView("sqlEditorTool.connections", {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
    vscode.window.registerWebviewViewProvider("sqlEditorTool.search", search, {
      // 入力中の文字と結果を、サイドバーを切り替えても保つ
      webviewOptions: { retainContextWhenHidden: true },
    }),
    reportTree,
    reports,
    vscode.window.createTreeView("sqlEditorTool.reports", {
      treeDataProvider: reportTree,
      showCollapseAll: true,
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("sqlEditorTool.reports.folder")) {
        reportTree.refresh();
      }
    }),
    store.onDidChange(() => {
      tree.refresh();
      search.update();
      reports.connectionsChanged();
    }),
    manager.onDidChange(() => {
      tree.refresh();
      search.update();
    }),

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

    vscode.commands.registerCommand("sqlEditorTool.refresh", () => {
      tree.refresh();
      search.reload();
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

    // ── レポート（D-29、§16）────────────────────────
    vscode.commands.registerCommand("sqlEditorTool.newReport", async () => {
      const uri = await createReport();
      if (!uri) return;
      reportTree.refresh();
      // SQL を書くエディタと、レポートの画面を並べて開く
      await vscode.window.showTextDocument(uri, {
        viewColumn: vscode.ViewColumn.One,
      });
      await openReport(uri);
    }),

    vscode.commands.registerCommand(
      "sqlEditorTool.openReport",
      async (target?: vscode.Uri | ReportNode) => {
        const uri =
          target instanceof vscode.Uri
            ? target
            : target?.kind === "report"
              ? target.uri
              : vscode.window.activeTextEditor?.document.uri;
        if (uri?.path.toLowerCase().endsWith(".sql")) {
          await openReport(uri);
        } else {
          await vscode.commands.executeCommand("sqlEditorTool.showReports");
        }
      },
    ),

    vscode.commands.registerCommand("sqlEditorTool.showReports", async () => {
      const folder = reportsFolder();
      if (!folder) {
        const answer = await vscode.window.showInformationMessage(
          "レポートのフォルダがまだありません。新しいレポートを作りますか？",
          "新しいレポート",
        );
        if (answer)
          await vscode.commands.executeCommand("sqlEditorTool.newReport");
        return;
      }
      const files = await listReports(folder);
      const order = recent.list();
      const rank = (uri: vscode.Uri) => {
        const i = order.indexOf(uri.toString());
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      files.sort(
        (a, b) =>
          rank(a.uri) - rank(b.uri) ||
          `${a.folder}/${a.name}`.localeCompare(`${b.folder}/${b.name}`, "ja"),
      );
      const picked = await vscode.window.showQuickPick(
        files.map((file) => ({
          label: file.name,
          description: [
            order.includes(file.uri.toString()) ? "最近使った" : "",
            file.folder,
          ]
            .filter(Boolean)
            .join(" · "),
          uri: file.uri,
        })),
        {
          title: "レポートを開く",
          placeHolder: "レポートの名前で検索",
          matchOnDescription: true,
        },
      );
      if (picked) await openReport(picked.uri);
    }),

    vscode.commands.registerCommand(
      "sqlEditorTool.editReportSql",
      async (node?: ReportNode) => {
        if (node?.kind === "report")
          await vscode.window.showTextDocument(node.uri);
      },
    ),

    vscode.commands.registerCommand(
      "sqlEditorTool.revealReport",
      async (node?: ReportNode) => {
        if (node)
          await vscode.commands.executeCommand("revealFileInOS", node.uri);
      },
    ),

    vscode.commands.registerCommand(
      "sqlEditorTool.renameReport",
      async (node?: ReportNode) => {
        if (node?.kind !== "report") return;
        const name = await vscode.window.showInputBox({
          title: "レポートの名前を変更",
          value: node.name,
          validateInput: (text) =>
            !text.trim()
              ? "名前を入力してください"
              : /[\\/:*?"<>|]/.test(text)
                ? '名前に \\ / : * ? " < > | は使えません'
                : undefined,
        });
        if (name === undefined || name.trim() === node.name) return;
        const target = vscode.Uri.joinPath(
          node.uri,
          "..",
          `${name.trim()}.sql`,
        );
        await vscode.workspace.fs.rename(node.uri, target, {
          overwrite: false,
        });
        reportTree.refresh();
      },
    ),

    vscode.commands.registerCommand(
      "sqlEditorTool.deleteReport",
      async (node?: ReportNode) => {
        if (node?.kind !== "report") return;
        const answer = await vscode.window.showWarningMessage(
          `レポート「${node.name}」を削除しますか？（ごみ箱に移します）`,
          { modal: true },
          "削除",
        );
        if (answer !== "削除") return;
        await vscode.workspace.fs.delete(node.uri, { useTrash: true });
        reportTree.refresh();
      },
    ),

    vscode.commands.registerCommand("sqlEditorTool.refreshReports", () =>
      reportTree.refresh(),
    ),

    vscode.commands.registerCommand(
      "sqlEditorTool.changeReportsFolder",
      async () => {
        if (await chooseReportsFolder()) reportTree.refresh();
      },
    ),
  );
}

export async function deactivate(): Promise<void> {
  await sessions?.closeAll();
}
