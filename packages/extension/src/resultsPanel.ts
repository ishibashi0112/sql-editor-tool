// 「SQL の結果」のパネル（VS Code の下のパネルの Webview、D-41）と、.sql の実行（Ctrl+Enter・▶・CodeLens）。
// 選んだ範囲か、カーソルのある文を実行し、ファイルごとのタブに結果を出す。制御は host の ResultsController。
// 接続は補完と同じ（D-39 の決め方）

import { randomBytes } from "node:crypto";
import {
  getDialect,
  type ReportConfig,
  splitStatements,
  statementAt,
} from "@sql-editor-tool/core";
import {
  describeResultColumns,
  type FromResults,
  type ReportConnection,
  type ReportFormValues,
  ResultsController,
  type RunStatement,
} from "@sql-editor-tool/host";
import * as vscode from "vscode";
import type { ConnectionProfile, ConnectionStore } from "./connections";
import { fileConfig, STATE_KEYS, saveParamSettings } from "./fileSettings";
import type { SessionManager } from "./sessions";
import {
  dialectOf,
  isSqlDocument,
  SQL_SELECTOR,
  type SqlEditing,
} from "./sqlEditing";
import { connectPrefs } from "./viewPrefs";

export const RESULTS_VIEW_ID = "sqlEditorTool.results";

const CODE_LENS_SETTING = "run.codeLens";

export type ResultsPanelDeps = {
  extensionUri: vscode.Uri;
  store: ConnectionStore;
  sessions: SessionManager;
  editing: SqlEditing;
  state: vscode.Memento;
};

export class ResultsPanel
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private viewDisposables: vscode.Disposable[] = [];
  private readonly controller: ResultsController;
  /** 結果のタブのファイル（URI）→ 実行した接続の ID（ファイルを閉じても、取り直しや候補の取得に使う） */
  private readonly profiles = new Map<string, string>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  /** 実行した範囲を一瞬だけ色を付けて見せる */
  private readonly flash = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(
      "editor.findMatchHighlightBackground",
    ),
  });
  private readonly disposables: vscode.Disposable[] = [];
  private saveValuesTimer: ReturnType<typeof setTimeout> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: ResultsPanelDeps) {
    this.controller = new ResultsController({
      post: (message) => void this.view?.webview.postMessage(message),
      openSession: async (source) => {
        const profile = this.profileOf(source);
        if (!profile) throw new Error("実行する接続を選んでください");
        return deps.sessions.get(profile);
      },
      settings: {
        maxRows: vscode.workspace
          .getConfiguration("sqlEditorTool")
          .get<number>("maxRows", 100000),
      },
      copyText: async (text) => {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.setStatusBarMessage("SQL をコピーしました", 3000);
      },
      savedValues: (source) => this.allValues()[source],
      saveValues: (source, values) => this.saveValues(source, values),
      saveConfig: (source, config) => this.saveConfig(source, config),
      reveal: (source, statement) => void this.reveal(source, statement),
      chooseConnection: (source) => void this.chooseConnection(source),
      describeColumns: async (source, text, names) => {
        const profile = this.profileOf(source);
        if (!profile) return [];
        return describeResultColumns({
          dialect: dialectOf(profile),
          text,
          cache: deps.editing.cacheFor(profile),
          names,
        });
      },
      focus: () => this.view?.show(false),
    });

    this.disposables.push(
      this.flash,
      this.lensesChanged,
      vscode.commands.registerCommand("sqlEditorTool.runSql", () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && isSqlDocument(editor.document)) void this.run(editor);
      }),
      vscode.commands.registerCommand(
        "sqlEditorTool.runStatementAt",
        async (uri?: vscode.Uri, offset?: number) => {
          if (!uri || offset === undefined) return;
          const editor = await vscode.window.showTextDocument(uri, {
            preserveFocus: false,
          });
          await this.run(editor, offset);
        },
      ),
      vscode.languages.registerCodeLensProvider(SQL_SELECTOR, {
        onDidChangeCodeLenses: this.lensesChanged.event,
        provideCodeLenses: (document) => this.codeLenses(document),
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`sqlEditorTool.${CODE_LENS_SETTING}`)) {
          this.lensesChanged.fire();
        }
      }),
      // エディタでファイルを前に出したら、そのファイルの結果のタブを前に出す
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && isSqlDocument(editor.document)) {
          this.controller.activate(editor.document.uri.toString());
        }
      }),
      // 接続を選び直したら、そのファイルのタブの接続も変える
      deps.editing.onDidChangeConnection((document) => {
        this.lensesChanged.fire();
        this.refresh(document);
      }),
      deps.store.onDidChange(() => this.lensesChanged.fire()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview");
    for (const d of this.viewDisposables.splice(0)) d.dispose();
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = html(view.webview, root);
    this.viewDisposables.push(
      view.webview.onDidReceiveMessage((message: FromResults) => {
        if (message.type === "toggleMaximize") {
          void vscode.commands.executeCommand(
            "workbench.action.toggleMaximizedPanel",
          );
          return;
        }
        this.controller.handle(message).catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            error instanceof Error ? error.message : String(error),
          );
        });
      }),
      connectPrefs(view.webview),
    );
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  dispose(): void {
    clearTimeout(this.saveValuesTimer);
    clearTimeout(this.flashTimer);
    this.controller.dispose();
    for (const d of [...this.viewDisposables, ...this.disposables]) d.dispose();
  }

  /**
   * 実行する。範囲を選んでいればその部分（文がいくつあってもよい）、なければ offset（省略時はカーソル）の文。
   * 接続が決まっていなければ、先に選んでもらう
   */
  async run(editor: vscode.TextEditor, offset?: number): Promise<void> {
    const { document } = editor;
    let profile = this.deps.editing.connectionFor(document).profile;
    if (!profile) {
      if (!(await this.deps.editing.choose(document))) return;
      profile = this.deps.editing.connectionFor(document).profile;
      if (!profile) return;
    }
    const statements = targetStatements(editor, dialectOf(profile), offset);
    if (statements.length === 0) {
      void vscode.window.showInformationMessage(
        "実行する SQL がありません（SELECT か WITH で始まる文を書いてください）",
      );
      return;
    }
    const source = document.uri.toString();
    this.profiles.set(source, profile.id);
    this.controller.run({
      source,
      label: fileName(document.uri),
      statements,
      config: this.configOf(document),
      connection: connectionOf(profile),
    });
    this.flashRanges(editor, statements);
    await this.show(editor);
  }

  private codeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const enabled = vscode.workspace
      .getConfiguration("sqlEditorTool")
      .get<boolean>(CODE_LENS_SETTING, true);
    if (!enabled) return [];
    const { profile } = this.deps.editing.connectionFor(document);
    const statements = splitStatements(
      getDialect(dialectOf(profile)),
      document.getText(),
    );
    const key = process.platform === "darwin" ? "⌘+Enter" : "Ctrl+Enter";
    return statements.map((s) => {
      const position = document.positionAt(s.start);
      return new vscode.CodeLens(new vscode.Range(position, position), {
        title: "▶ 実行",
        tooltip: profile
          ? `この文を「${profile.name}」で実行します（カーソルを置いて ${key} でも実行できます）`
          : `この文を実行します（先に接続を選びます。${key} でも実行できます）`,
        command: "sqlEditorTool.runStatementAt",
        arguments: [document.uri, s.start],
      });
    });
  }

  /** 下のパネルに結果を出す。エディタのフォーカスはそのまま（続けて書けるように） */
  private async show(editor: vscode.TextEditor): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    // まだ一度も開いていなければ、パネルを開いてからエディタに戻る
    await vscode.commands.executeCommand(`${RESULTS_VIEW_ID}.focus`);
    await vscode.window.showTextDocument(editor.document, {
      ...(editor.viewColumn ? { viewColumn: editor.viewColumn } : {}),
      selection: editor.selection,
      preserveFocus: false,
    });
  }

  private flashRanges(
    editor: vscode.TextEditor,
    statements: readonly RunStatement[],
  ): void {
    const { document } = editor;
    editor.setDecorations(
      this.flash,
      statements.map(
        (s) =>
          new vscode.Range(
            document.positionAt(s.start),
            document.positionAt(s.end),
          ),
      ),
    );
    // 続けて実行したときに、前の実行の消す時刻で消さないように
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(
      () => editor.setDecorations(this.flash, []),
      700,
    );
  }

  private profileOf(source: string): ConnectionProfile | undefined {
    const id = this.profiles.get(source);
    return id === undefined ? undefined : this.deps.store.get(id);
  }

  /** ファイルの設定のコメントや接続が変わったら、そのファイルのタブを作り直す */
  private refresh(document: vscode.TextDocument): void {
    const source = document.uri.toString();
    if (!this.controller.has(source)) return;
    const { profile } = this.deps.editing.connectionFor(document);
    if (profile) this.profiles.set(source, profile.id);
    else this.profiles.delete(source);
    this.controller.update(
      source,
      this.configOf(document),
      profile ? connectionOf(profile) : null,
    );
  }

  private async chooseConnection(source: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(source),
    );
    // 選んだら onDidChangeConnection でタブを作り直す
    await this.deps.editing.choose(document);
  }

  /** .sql の入力欄の設定（VS Code に覚えたものと、先頭の設定のコメント） */
  private configOf(document: vscode.TextDocument): ReportConfig | null {
    return fileConfig(
      this.deps.state,
      document.uri.toString(),
      document.getText(),
    );
  }

  /** 入力欄の設定を VS Code の中に覚える（.sql は書き換えない。D-44） */
  private async saveConfig(
    source: string,
    config: ReportConfig,
  ): Promise<void> {
    await saveParamSettings(this.deps.state, source, config.params ?? {});
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(source),
    );
    this.refresh(document);
  }

  /** エディタでその文を選ぶ（ファイルが変わっていても、なるべく近い位置） */
  private async reveal(source: string, statement: RunStatement): Promise<void> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(source),
    );
    const text = document.getText();
    const same = text.slice(statement.start, statement.end) === statement.sql;
    const found = same ? statement.start : text.indexOf(statement.sql);
    const start = found >= 0 ? found : statement.start;
    const range = new vscode.Range(
      document.positionAt(start),
      document.positionAt(found >= 0 ? start + statement.sql.length : start),
    );
    const editor = await vscode.window.showTextDocument(document, {
      selection: range,
      preserveFocus: false,
    });
    editor.revealRange(
      range,
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  private allValues(): Record<string, ReportFormValues> {
    return this.deps.state.get<Record<string, ReportFormValues>>(
      STATE_KEYS.formValues,
      {},
    );
  }

  private saveValues(source: string, values: ReportFormValues): void {
    clearTimeout(this.saveValuesTimer);
    this.saveValuesTimer = setTimeout(() => {
      void this.deps.state.update(STATE_KEYS.formValues, {
        ...this.allValues(),
        [source]: values,
      });
    }, 500);
  }
}

/** 実行する文。範囲を選んでいればその中の文、なければ offset（省略時はカーソル）の文 */
function targetStatements(
  editor: vscode.TextEditor,
  dialect: ReturnType<typeof dialectOf>,
  offset: number | undefined,
): RunStatement[] {
  const { document, selection } = editor;
  const toStatement = (
    text: string,
    base: number,
    s: { start: number; end: number },
  ): RunStatement => ({
    sql: text.slice(s.start, s.end),
    start: base + s.start,
    end: base + s.end,
    line: document.positionAt(base + s.start).line,
  });
  if (offset === undefined && !selection.isEmpty) {
    const selected = document.getText(selection);
    const base = document.offsetAt(selection.start);
    return splitStatements(getDialect(dialect), selected).map((s) =>
      toStatement(selected, base, s),
    );
  }
  const text = document.getText();
  const at = offset ?? document.offsetAt(selection.active);
  const found = statementAt(splitStatements(getDialect(dialect), text), at);
  return found ? [toStatement(text, 0, found)] : [];
}

function connectionOf(profile: ConnectionProfile): ReportConnection {
  return {
    name: profile.name,
    dialect: dialectOf(profile),
    demo: profile.driver === "demo",
  };
}

function fileName(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || "無題";
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "results.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "results.css"));
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
