// サイドバーの接続ツリー：接続 → スキーマ → テーブル／ビュー。名前での検索は TreeView の標準の絞り込みを使う

import type { TableRef } from "@sql-editor-tool/core";
import * as vscode from "vscode";
import type { ConnectionProfile, ConnectionStore } from "./connections";
import type { SessionManager } from "./sessions";

export type TreeNode =
  | { kind: "connection"; profile: ConnectionProfile }
  | { kind: "schema"; profile: ConnectionProfile; schema: string }
  | {
      kind: "object";
      profile: ConnectionProfile;
      table: TableRef;
      objectKind: "table" | "view";
    };

export class ConnectionTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {}

  refresh(node?: TreeNode): void {
    this.changed.fire(node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    switch (node.kind) {
      case "connection": {
        const item = new vscode.TreeItem(node.profile.name, collapsed);
        item.id = node.profile.id;
        item.contextValue = "connection";
        item.description = describe(node.profile);
        item.iconPath = new vscode.ThemeIcon(
          "database",
          this.sessions.isOpen(node.profile.id)
            ? new vscode.ThemeColor("charts.green")
            : undefined,
        );
        return item;
      }
      case "schema": {
        const item = new vscode.TreeItem(node.schema, collapsed);
        item.id = `${node.profile.id}/${node.schema}`;
        item.iconPath = new vscode.ThemeIcon("folder");
        return item;
      }
      case "object": {
        const item = new vscode.TreeItem(node.table.name);
        item.id = `${node.profile.id}/${node.table.schema}/${node.table.name}`;
        item.contextValue = node.objectKind;
        item.iconPath = new vscode.ThemeIcon(
          node.objectKind === "view" ? "eye" : "table",
        );
        if (node.objectKind === "view") item.description = "ビュー";
        item.command = {
          command: "sqlEditorTool.openTable",
          title: "データを開く",
          arguments: [node],
        };
        return item;
      }
    }
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      return this.store
        .list()
        .map((profile) => ({ kind: "connection", profile }));
    }
    try {
      const session = await this.sessions.get(node.profile);
      switch (node.kind) {
        case "connection": {
          const schemas = await session.listSchemas();
          return schemas.map((schema) => ({
            kind: "schema",
            profile: node.profile,
            schema,
          }));
        }
        case "schema": {
          const objects = await session.listObjects(node.schema);
          return objects.map((object) => ({
            kind: "object",
            profile: node.profile,
            table: { schema: node.schema, name: object.name },
            objectKind: object.kind,
          }));
        }
        case "object":
          return [];
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `「${node.profile.name}」に接続できませんでした：${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}

function describe(profile: ConnectionProfile): string {
  switch (profile.driver) {
    case "mssql":
      return "SQL Server";
    case "oracle":
      return "Oracle";
    case "demo":
      return `デモ（${profile.dialect === "mssql" ? "SQL Server" : "Oracle"}）`;
  }
}
