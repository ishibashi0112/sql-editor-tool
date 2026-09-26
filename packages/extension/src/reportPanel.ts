// レポートの画面（Webview のパネル）。制御は host の ReportController に任せ、ここは VS Code とのつなぎだけ。
// .sql の中身は VS Code の文書から読む（保存していない編集もそのまま使う）。1 つのファイルに 1 つのパネル

import { randomBytes } from "node:crypto";
import {
  parseReportConfig,
  type ReportConfig,
  writeReportConfig,
} from "@sql-editor-tool/core";
import {
  type FromReport,
  type ReportConnection,
  ReportController,
  type ReportFormValues,
} from "@sql-editor-tool/host";
import * as vscode from "vscode";
import type { ConnectionProfile, ConnectionStore } from "./connections";
import { type RecentReports, reportName } from "./reports";
import type { SessionManager } from "./sessions";
import { describe } from "./tree";

const VALUES_KEY = "sqlEditorTool.reportValues";

export type ReportPanelDeps = {
  extensionUri: vscode.Uri;
  store: ConnectionStore;
  sessions: SessionManager;
  recent: RecentReports;
  /** フォームの値を覚えておく場所（次に開いたときに入れる） */
  state: vscode.Memento;
};

export class ReportPanels {
  private readonly panels = new Map<string, ReportPanel>();

  constructor(private readonly deps: ReportPanelDeps) {}

  /** レポートの画面を開く（開いていれば前に出す） */
  async open(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const opened = this.panels.get(key);
    if (opened) {
      opened.reveal();
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const panel = new ReportPanel(this.deps, document, () =>
      this.panels.delete(key),
    );
    this.panels.set(key, panel);
    await this.deps.recent.add(uri);
  }

  /** 接続を追加・削除・名前を変更したとき */
  connectionsChanged(): void {
    for (const panel of this.panels.values()) void panel.reload();
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) panel.dispose();
  }
}

class ReportPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly controller: ReportController;
  private readonly disposables: vscode.Disposable[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private saveValuesTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly uri: vscode.Uri;
  /** 最後に読んだ .sql の全文 */
  private text: string;

  constructor(
    private readonly deps: ReportPanelDeps,
    /** VS Code は表示していない文書を閉じることがあるので、使うときに document() で開き直す */
    private openedDocument: vscode.TextDocument,
    onDispose: () => void,
  ) {
    this.uri = openedDocument.uri;
    const root = vscode.Uri.joinPath(deps.extensionUri, "dist", "webview");
    const title = reportName(this.uri);
    this.panel = vscode.window.createWebviewPanel(
      "sqlEditorTool.report",
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // 取得した行を、タブを切り替えても保つ
        retainContextWhenHidden: true,
        localResourceRoots: [root],
      },
    );
    this.panel.webview.html = html(this.panel.webview, root);

    this.text = openedDocument.getText();
    this.controller = new ReportController({
      title,
      text: this.text,
      connection: this.connection(this.text),
      openSession: () => this.openSession(),
      settings: {
        maxRows: vscode.workspace
          .getConfiguration("sqlEditorTool")
          .get<number>("maxRows", 100000),
      },
      initialValues: this.savedValues(),
      post: (message) => void this.panel.webview.postMessage(message),
      copyText: async (sql) => {
        await vscode.env.clipboard.writeText(sql);
        void vscode.window.setStatusBarMessage("SQL をコピーしました", 3000);
      },
      saveConfig: (config) => this.saveConfig(config),
      editSql: () => {
        void vscode.window.showTextDocument(this.uri, {
          viewColumn: vscode.ViewColumn.Beside,
        });
      },
      chooseConnection: () => void this.chooseConnection(),
      onValuesChanged: (values) => this.saveValues(values),
    });

    // エディタの外（エクスプローラーや別のツール）でファイルが書き換わったとき
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.joinPath(this.uri, ".."),
        this.uri.path.split("/").pop() ?? "",
      ),
    );
    watcher.onDidChange(() => this.scheduleReload());
    this.disposables.push(
      watcher,
      this.panel.webview.onDidReceiveMessage((message: FromReport) => {
        this.controller.handle(message).catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
        });
      }),
      // SQL を書き換えたら、入力欄を作り直す（保存していない編集も含む）
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === this.uri.toString()) {
          this.scheduleReload();
        }
      }),
    );
    this.panel.onDidDispose(() => {
      this.dispose();
      onDispose();
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  async reload(): Promise<void> {
    this.text = (await this.document()).getText();
    this.controller.update(this.text, this.connection(this.text));
  }

  private async document(): Promise<vscode.TextDocument> {
    if (this.openedDocument.isClosed) {
      this.openedDocument = await vscode.workspace.openTextDocument(this.uri);
    }
    return this.openedDocument;
  }

  dispose(): void {
    clearTimeout(this.reloadTimer);
    this.controller.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }

  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), 300);
  }

  /** 設定の接続名に合う接続 */
  private profile(text: string): ConnectionProfile | undefined {
    const name = parseReportConfig(text).config.connection;
    return name
      ? this.deps.store.list().find((p) => p.name === name)
      : undefined;
  }

  private connection(text: string): ReportConnection | null {
    const profile = this.profile(text);
    if (!profile) return null;
    return {
      name: profile.name,
      dialect: profile.driver === "demo" ? profile.dialect : profile.driver,
      demo: profile.driver === "demo",
    };
  }

  private openSession() {
    const profile = this.profile(this.text);
    if (!profile) throw new Error("実行する接続を選んでください");
    return this.deps.sessions.get(profile);
  }

  private async chooseConnection(): Promise<void> {
    const profiles = this.deps.store.list();
    if (profiles.length === 0) {
      void vscode.window.showWarningMessage(
        "接続がありません。サイドバーの「接続」で接続を追加してください",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((profile) => ({
        label: profile.name,
        description: describe(profile),
        profile,
      })),
      { title: "このレポートを実行する接続" },
    );
    if (!picked) return;
    const { config } = parseReportConfig((await this.document()).getText());
    await this.saveConfig({ ...config, connection: picked.profile.name });
  }

  /** 設定を .sql の先頭のコメントに書く。保存していない編集がなければ、ファイルも保存する */
  private async saveConfig(config: ReportConfig): Promise<void> {
    const document = await this.document();
    const wasDirty = document.isDirty;
    const current = document.getText();
    const next = writeReportConfig(current, config);
    if (next !== current) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        this.uri,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(current.length),
        ),
        next,
      );
      await vscode.workspace.applyEdit(edit);
      if (!wasDirty) await document.save();
    }
    clearTimeout(this.reloadTimer);
    await this.reload();
  }

  private savedValues(): ReportFormValues | undefined {
    const all = this.deps.state.get<Record<string, ReportFormValues>>(
      VALUES_KEY,
      {},
    );
    return all[this.uri.toString()];
  }

  private saveValues(values: ReportFormValues): void {
    clearTimeout(this.saveValuesTimer);
    this.saveValuesTimer = setTimeout(() => {
      const all = this.deps.state.get<Record<string, ReportFormValues>>(
        VALUES_KEY,
        {},
      );
      void this.deps.state.update(VALUES_KEY, {
        ...all,
        [this.uri.toString()]: values,
      });
    }, 500);
  }
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "report.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "report.css"));
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
