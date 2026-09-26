// サイドバーのテーブル検索（Webview のビュー、D-30）。
// 接続を開いたら、その DB のテーブルとビューの一覧を 1 回取っておき、画面に渡す。絞り込みは画面の側で行う

import { randomBytes } from "node:crypto";
import type {
  FromSearchView,
  SchemaObject,
  SearchConnection,
  ToSearchView,
} from "@sql-editor-tool/host";
import * as vscode from "vscode";
import type { ConnectionStore } from "./connections";
import type { SessionManager } from "./sessions";
import { describe, type TreeNode } from "./tree";

type Loaded = {
  status: "loading" | "ready" | "error";
  objects: SchemaObject[];
  message?: string;
};

export class TableSearchView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** 開いている接続ごとの一覧。閉じたら消す */
  private readonly loaded = new Map<string, Loaded>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = html(view.webview, root);
    view.webview.onDidReceiveMessage((message: FromSearchView) =>
      this.handle(message),
    );
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** 接続を開いた・閉じた・追加した・削除したとき */
  update(): void {
    for (const profile of this.store.list()) {
      if (!this.sessions.isOpen(profile.id)) {
        this.loaded.delete(profile.id);
      } else if (!this.loaded.has(profile.id)) {
        this.load(profile.id);
      }
    }
    for (const id of this.loaded.keys()) {
      if (!this.store.get(id)) this.loaded.delete(id);
    }
    this.post();
  }

  /** 「最新の情報に更新」で、一覧を取り直す */
  reload(): void {
    this.loaded.clear();
    this.update();
  }

  private load(id: string): void {
    const profile = this.store.get(id);
    if (!profile) return;
    const entry: Loaded = { status: "loading", objects: [] };
    this.loaded.set(id, entry);
    this.sessions
      .get(profile)
      .then((session) => session.listAllObjects())
      .then(
        (objects) => {
          entry.status = "ready";
          entry.objects = objects;
        },
        (error: unknown) => {
          entry.status = "error";
          entry.message =
            error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        // 取り直しや切断で入れ替わっていたら、古い結果は出さない
        if (this.loaded.get(id) === entry) this.post();
      });
  }

  private post(): void {
    if (!this.view) return;
    const connections: SearchConnection[] = this.store.list().map((profile) => {
      const entry = this.loaded.get(profile.id);
      return {
        id: profile.id,
        name: profile.name,
        description: describe(profile),
        status: entry?.status ?? "closed",
        message: entry?.message,
        objects: entry?.status === "ready" ? entry.objects : [],
      };
    });
    const message: ToSearchView = { type: "state", connections };
    void this.view.webview.postMessage(message);
  }

  private handle(message: FromSearchView): void {
    switch (message.type) {
      case "ready":
        this.update();
        return;
      case "connect": {
        const profile = this.store.get(message.connectionId);
        if (!profile) return;
        // 一覧を取れなかった接続は、取り直す
        this.loaded.delete(profile.id);
        this.sessions.get(profile).catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            `「${profile.name}」に接続できませんでした：${error instanceof Error ? error.message : String(error)}`,
          );
          this.update();
        });
        this.update();
        return;
      }
      case "open": {
        const profile = this.store.get(message.connectionId);
        if (!profile) return;
        const { schema, name, kind } = message.object;
        const node: TreeNode = {
          kind: "object",
          profile,
          table: { schema, name },
          objectKind: kind,
        };
        void vscode.commands.executeCommand("sqlEditorTool.openTable", node);
        return;
      }
    }
  }
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "search.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "search.css"));
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource}`,
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
