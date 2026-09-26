// サイドバーの「レポート」ビュー：レポートのフォルダの中の .sql を、フォルダの形のまま並べる（D-29）。
// クリックでレポートの画面を開く。名前での検索は TreeView の標準の絞り込みを使う

import * as vscode from "vscode";
import { reportName, reportsFolder } from "./reports";

export type ReportNode =
  | { kind: "folder"; uri: vscode.Uri; name: string }
  | { kind: "report"; uri: vscode.Uri; name: string };

export class ReportTree implements vscode.TreeDataProvider<ReportNode> {
  private readonly changed = new vscode.EventEmitter<ReportNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor() {
    this.watch();
  }

  /** フォルダの設定が変わったとき・「最新の情報に更新」 */
  refresh(): void {
    this.watch();
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.watcher?.dispose();
    this.changed.dispose();
  }

  getTreeItem(node: ReportNode): vscode.TreeItem {
    if (node.kind === "folder") {
      const item = new vscode.TreeItem(
        node.name,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = node.uri.toString();
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = "reportFolder";
      return item;
    }
    const item = new vscode.TreeItem(node.name);
    item.id = node.uri.toString();
    item.resourceUri = node.uri;
    item.iconPath = new vscode.ThemeIcon("graph");
    item.tooltip = node.uri.fsPath;
    item.contextValue = "report";
    item.command = {
      command: "sqlEditorTool.openReport",
      title: "レポートを開く",
      arguments: [node.uri],
    };
    return item;
  }

  async getChildren(node?: ReportNode): Promise<ReportNode[]> {
    const dir = node?.kind === "folder" ? node.uri : reportsFolder();
    if (!dir) return [];
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }
    const folders: ReportNode[] = [];
    const reports: ReportNode[] = [];
    for (const [name, type] of entries) {
      if (name.startsWith(".")) continue;
      const uri = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) {
        folders.push({ kind: "folder", uri, name });
      } else if (name.toLowerCase().endsWith(".sql")) {
        reports.push({ kind: "report", uri, name: reportName(uri) });
      }
    }
    const byName = (a: ReportNode, b: ReportNode) =>
      a.name.localeCompare(b.name, "ja");
    return [...folders.sort(byName), ...reports.sort(byName)];
  }

  /** フォルダの中の追加・削除・名前の変更を一覧に映す */
  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const folder = reportsFolder();
    void vscode.commands.executeCommand(
      "setContext",
      "sqlEditorTool.reportsFolderSet",
      folder !== undefined,
    );
    if (!folder) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "**/*"),
    );
    const fire = () => this.changed.fire(undefined);
    this.watcher.onDidCreate(fire);
    this.watcher.onDidDelete(fire);
  }
}
