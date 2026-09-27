// .sql の編集の支援（D-39、D-40）：テーブル名・列名・キーワードの入力補完、論理名のホバーとインレイヒント、
// 補完・実行に使う接続を選ぶステータスバー。
// 先頭にレポートの設定のコメントがある .sql は、そのコメントの接続を使う（D-29）。
// それ以外の .sql は、ファイルごとに選んだ接続を VS Code の中に覚えておく（ファイルには書かない）。
// 選んでいなければ、つないでいる接続が 1 つならそれを使う。未接続なら、補完のときに接続する。
// ほかの拡張機能が .sql を別の言語（ID が sql でないもの）として扱うことがあるので、拡張子でも判定する

import {
  columnTypeLabel,
  completionContext,
  type DialectName,
  getDialect,
  hasReportHeader,
  parseReportConfig,
  shortLogicalName,
  writeReportConfig,
} from "@sql-editor-tool/core";
import {
  type CompletionEntry,
  completeSql,
  resolveSymbols,
  SchemaCache,
  type SqlSymbol,
  symbolAt,
} from "@sql-editor-tool/host";
import * as vscode from "vscode";
import type { ConnectionProfile, ConnectionStore } from "./connections";
import type { SessionManager } from "./sessions";
import { describe } from "./tree";

/** 先頭に設定のコメントがない .sql の、ファイル（URI）→ 接続名。空文字は「使わない」 */
const FILE_CONNECTIONS_KEY = "sqlEditorTool.sqlConnections";

/**
 * 補完する文書。言語 ID が sql のもの（VS Code の標準）と、拡張子が .sql のもの
 * （SQL の拡張機能が別の言語 ID を付けていても動くように）
 */
export const SQL_SELECTOR: vscode.DocumentSelector = [
  { language: "sql" },
  { pattern: "**/*.sql" },
  { pattern: "**/*.SQL" },
];

/** 論理名のインレイヒントを出すか（D-40） */
const HINTS_SETTING = "logicalNames.inlayHints";

/** 接続できなかった後、ホバーとインレイヒントのために接続し直すまでの間（ミリ秒） */
const RETRY_AFTER_MS = 60_000;

export function isSqlDocument(
  document: vscode.TextDocument | undefined,
): boolean {
  if (!document) return false;
  return document.languageId === "sql" || /\.sql$/i.test(document.uri.path);
}

/** この .sql の補完・実行に使う接続。auto は、選んでいないので自動で決めたもの */
export type SqlConnection = {
  name: string | null;
  profile: ConnectionProfile | undefined;
  auto: boolean;
  /** 先頭に設定のコメントがある（接続はコメントに書く） */
  report: boolean;
};

const KINDS: Record<CompletionEntry["kind"], vscode.CompletionItemKind> = {
  column: vscode.CompletionItemKind.Field,
  key: vscode.CompletionItemKind.Field,
  table: vscode.CompletionItemKind.Class,
  view: vscode.CompletionItemKind.Interface,
  schema: vscode.CompletionItemKind.Module,
  keyword: vscode.CompletionItemKind.Keyword,
};

export class SqlEditing implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  /** 接続の ID → テーブルの一覧と列 */
  private readonly caches = new Map<string, SchemaCache>();
  /** 接続できなかったことは、同じ接続では 1 回だけ知らせる */
  private readonly warned = new Set<string>();
  /** 接続の ID → ホバー・インレイヒントのために接続して失敗した時刻（しばらくは接続し直さない） */
  private readonly failedAt = new Map<string, number>();
  private readonly hintsChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: ConnectionStore,
    private readonly sessions: SessionManager,
    private readonly state: vscode.Memento,
  ) {
    this.status = vscode.window.createStatusBarItem(
      "sqlEditorTool.sqlConnection",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.status.name = "SQL の補完に使う接続";
    this.status.command = "sqlEditorTool.chooseSqlConnection";
    this.disposables.push(
      this.status,
      vscode.languages.registerCompletionItemProvider(
        SQL_SELECTOR,
        {
          provideCompletionItems: (document, position) =>
            this.complete(document, position),
        },
        ".",
      ),
      vscode.languages.registerHoverProvider(SQL_SELECTOR, {
        provideHover: (document, position, token) =>
          this.hover(document, position, token),
      }),
      vscode.languages.registerInlayHintsProvider(SQL_SELECTOR, {
        onDidChangeInlayHints: this.hintsChanged.event,
        provideInlayHints: (document, range, token) =>
          this.inlayHints(document, range, token),
      }),
      this.hintsChanged,
      vscode.commands.registerCommand("sqlEditorTool.chooseSqlConnection", () =>
        this.choose(),
      ),
      vscode.commands.registerCommand(
        "sqlEditorTool.toggleLogicalNameHints",
        async () => {
          const config = vscode.workspace.getConfiguration("sqlEditorTool");
          const next = !config.get<boolean>(HINTS_SETTING, true);
          await config.update(
            HINTS_SETTING,
            next,
            vscode.ConfigurationTarget.Global,
          );
          void vscode.window.setStatusBarMessage(
            next ? "論理名を表示します" : "論理名を表示しません",
            3000,
          );
        },
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`sqlEditorTool.${HINTS_SETTING}`)) {
          this.hintsChanged.fire();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      // レポートの先頭のコメントで接続を書き換えたとき
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.updateStatus();
        }
      }),
      store.onDidChange(() => {
        // 接続先や名前が変わったかもしれないので、覚えた一覧は捨てる
        this.clear();
        this.updateStatus();
      }),
      // つないでいる接続が変わると、自動で選ぶ接続も変わる。つないだら論理名を出せる
      sessions.onDidChange(() => {
        this.updateStatus();
        this.hintsChanged.fire();
      }),
    );
    this.updateStatus();
  }

  /** 覚えたテーブルの一覧と列を捨てる（「最新の情報に更新」・切断のとき）。id を省くとすべて */
  clear(profileId?: string): void {
    for (const [id, cache] of this.caches) {
      if (profileId === undefined || id === profileId) cache.clear();
    }
    if (profileId === undefined) {
      this.warned.clear();
      this.failedAt.clear();
    } else {
      this.warned.delete(profileId);
      this.failedAt.delete(profileId);
    }
    this.hintsChanged.fire();
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  /** この .sql の補完に使う接続 */
  connectionFor(document: vscode.TextDocument): SqlConnection {
    const profiles = this.store.list();
    const byName = (name: string) => profiles.find((p) => p.name === name);
    const text = document.getText();
    if (hasReportHeader(text)) {
      const name = parseReportConfig(text).config.connection ?? null;
      if (name) {
        return { name, profile: byName(name), auto: false, report: true };
      }
    }
    const report = hasReportHeader(text);
    const map = this.fileConnections();
    const key = document.uri.toString();
    if (!report && Object.hasOwn(map, key)) {
      const name = map[key] ?? "";
      // 空文字は「使わない」を選んだもの
      return name
        ? { name, profile: byName(name), auto: false, report }
        : { name: null, profile: undefined, auto: false, report };
    }
    // 選んでいなければ、つないでいる接続が 1 つならそれ。接続が 1 つしかなければそれ
    const open = profiles.filter((p) => this.sessions.isOpen(p.id));
    const auto =
      open.length === 1
        ? open[0]
        : profiles.length === 1
          ? profiles[0]
          : undefined;
    return {
      name: auto?.name ?? null,
      profile: auto,
      auto: auto !== undefined,
      report,
    };
  }

  private fileConnections(): Record<string, string> {
    return this.state.get<Record<string, string>>(FILE_CONNECTIONS_KEY, {});
  }

  cacheFor(profile: ConnectionProfile): SchemaCache {
    let cache = this.caches.get(profile.id);
    if (!cache) {
      cache = new SchemaCache(() => this.sessions.get(profile));
      this.caches.set(profile.id, cache);
    }
    return cache;
  }

  private async complete(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionList> {
    const { profile } = this.connectionFor(document);
    const offset = document.offsetAt(position);
    const dialect = dialectOf(profile);
    try {
      const text = document.getText();
      const entries = await completeSql({
        dialect,
        text,
        offset,
        cache: profile ? this.cacheFor(profile) : null,
      });
      // 接続が決まらず、テーブル名・列名を出す位置なら、接続を選ぶ項目を出す
      if (!profile && needsSchema(dialect, text, offset)) {
        return new vscode.CompletionList([
          chooseItem(),
          ...entries.map(toItem),
        ]);
      }
      // キーワードの位置では、打った論理名で列を出すので、打つたびに候補を作り直す（D-40）
      const general =
        profile !== undefined &&
        completionContext(getDialect(dialect), text, offset).kind === "general";
      return new vscode.CompletionList(entries.map(toItem), general);
    } catch (error) {
      if (profile && !this.warned.has(profile.id)) {
        this.warned.add(profile.id);
        void vscode.window.showWarningMessage(
          `補完のために「${profile.name}」の情報を取れませんでした：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return new vscode.CompletionList([]);
    }
  }

  /**
   * ホバー・インレイヒントに使うテーブルの一覧と列。補完と同じ接続を使い、未接続なら接続する。
   * 接続できなかったら、しばらくは接続し直さない（知らせも出さない。ヒントは打つたびに求められるため）
   */
  private symbolSource(
    document: vscode.TextDocument,
  ): { dialect: DialectName; cache: SchemaCache; id: string } | null {
    const { profile } = this.connectionFor(document);
    if (!profile) return null;
    const failed = this.failedAt.get(profile.id);
    if (
      failed !== undefined &&
      !this.sessions.isOpen(profile.id) &&
      Date.now() - failed < RETRY_AFTER_MS
    ) {
      return null;
    }
    return {
      dialect: dialectOf(profile),
      cache: this.cacheFor(profile),
      id: profile.id,
    };
  }

  private async hover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const source = this.symbolSource(document);
    if (!source) return undefined;
    try {
      const symbol = await symbolAt({
        dialect: source.dialect,
        text: document.getText(),
        cache: source.cache,
        offset: document.offsetAt(position),
      });
      if (!symbol || token.isCancellationRequested) return undefined;
      return new vscode.Hover(
        symbolMarkdown(symbol),
        new vscode.Range(
          document.positionAt(symbol.start),
          document.positionAt(symbol.end),
        ),
      );
    } catch {
      this.failedAt.set(source.id, Date.now());
      return undefined;
    }
  }

  /** 名前の後ろに論理名を出す（D-40）。別名が論理名と同じなら出さない */
  private async inlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlayHint[]> {
    const enabled = vscode.workspace
      .getConfiguration("sqlEditorTool")
      .get<boolean>(HINTS_SETTING, true);
    const source = enabled ? this.symbolSource(document) : null;
    if (!source) return [];
    let symbols: SqlSymbol[];
    try {
      symbols = await resolveSymbols({
        dialect: source.dialect,
        text: document.getText(),
        cache: source.cache,
        from: document.offsetAt(range.start),
        to: document.offsetAt(range.end),
      });
    } catch {
      this.failedAt.set(source.id, Date.now());
      return [];
    }
    if (token.isCancellationRequested) return [];
    return symbols.flatMap((symbol) => {
      const name = logicalNameOf(symbol);
      if (!name || symbol.alias === name) return [];
      const hint = new vscode.InlayHint(
        document.positionAt(symbol.end),
        shortLogicalName(name),
      );
      hint.paddingLeft = true;
      hint.tooltip = symbolMarkdown(symbol);
      return [hint];
    });
  }

  private updateStatus(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !isSqlDocument(document)) {
      this.status.hide();
      return;
    }
    const { name, profile, auto } = this.connectionFor(document);
    if (profile) {
      this.status.text = `$(database) ${profile.name}${auto ? "（自動）" : ""}`;
      this.status.tooltip = auto
        ? `SQL の補完に使う接続：${profile.name}（${describe(profile)}）。つないでいる接続を自動で使っています。クリックで選ぶ`
        : `SQL の補完に使う接続：${profile.name}（${describe(profile)}）。クリックで変える`;
    } else if (name) {
      this.status.text = `$(warning) 接続「${name}」がありません`;
      this.status.tooltip = "クリックして、補完に使う接続を選び直す";
    } else {
      this.status.text = "$(database) 接続を選ぶ";
      this.status.tooltip =
        "SQL の補完に使う接続を選ぶ（テーブル名・列名を補完します）";
    }
    this.status.show();
  }

  /** 補完に使う接続を選ぶ。先頭に設定のコメントがあればコメントに書き、なければファイルごとに覚える */
  private async choose(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !isSqlDocument(document)) return;
    const profiles = this.store.list();
    if (profiles.length === 0) {
      void vscode.window.showWarningMessage(
        "接続がありません。サイドバーの「接続」で接続を追加してください",
      );
      return;
    }
    const resolved = this.connectionFor(document);
    const { report } = resolved;
    const current = resolved.auto ? null : resolved.name;
    const none = {
      label: "（使わない）",
      description: "このファイルでは、テーブル名・列名を補完しない",
      profile: undefined,
    };
    const picked = await vscode.window.showQuickPick(
      [
        ...profiles.map((profile) => ({
          label: profile.name,
          description: `${describe(profile)}${profile.name === current ? " · 選択中" : ""}`,
          profile,
        })),
        ...(report ? [] : [none]),
      ],
      {
        title: report
          ? "このレポートの接続（先頭のコメントに書きます）"
          : "この .sql の補完に使う接続",
      },
    );
    if (!picked) return;
    if (report) {
      if (picked.profile) await writeConnection(document, picked.profile.name);
    } else {
      const map = { ...this.fileConnections() };
      const key = document.uri.toString();
      map[key] = picked.profile?.name ?? "";
      await this.state.update(FILE_CONNECTIONS_KEY, map);
    }
    this.updateStatus();
  }
}

/** レポートの先頭のコメントに接続名を書く。保存していない編集がなければ、ファイルも保存する（レポートの画面と同じ） */
async function writeConnection(
  document: vscode.TextDocument,
  name: string,
): Promise<void> {
  const text = document.getText();
  const next = writeReportConfig(text, {
    ...parseReportConfig(text).config,
    connection: name,
  });
  if (next === text) return;
  const wasDirty = document.isDirty;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(0), document.positionAt(text.length)),
    next,
  );
  await vscode.workspace.applyEdit(edit);
  if (!wasDirty) await document.save();
}

/** テーブル名・列名を出す位置か（接続がないと何も出せない位置） */
function needsSchema(
  dialect: DialectName,
  text: string,
  offset: number,
): boolean {
  const kind = completionContext(getDialect(dialect), text, offset).kind;
  return kind === "member" || kind === "table";
}

/** 補完の一覧の先頭に出す「接続を選ぶ」。選ぶと、打った文字はそのままで接続を選ぶ画面を開く */
function chooseItem(): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    {
      label: "補完に使う接続を選ぶ…",
      description: "接続を選ぶと、テーブル名・列名が出ます",
    },
    vscode.CompletionItemKind.Event,
  );
  item.insertText = "";
  item.sortText = "\u0000";
  // 打ちかけの文字でも候補から消えないように
  item.filterText = " ";
  item.command = {
    command: "sqlEditorTool.chooseSqlConnection",
    title: "補完に使う接続を選ぶ",
  };
  return item;
}

function toItem(entry: CompletionEntry): vscode.CompletionItem {
  // 主キーの列は 🔑 を付ける（絞り込みは名前と論理名で行う）
  const label = entry.kind === "key" ? `🔑 ${entry.label}` : entry.label;
  const item = new vscode.CompletionItem(
    {
      label,
      // 論理名は名前のすぐ横に出す（D-40）
      ...(entry.logicalName ? { detail: `  ${entry.logicalName}` } : {}),
      description: entry.detail,
    },
    KINDS[entry.kind],
  );
  item.insertText = entry.insertText;
  item.sortText = entry.sortText;
  item.filterText = entry.filterText ?? entry.label;
  if (entry.comment) item.documentation = entry.comment;
  return item;
}

function dialectOf(profile: ConnectionProfile | undefined): DialectName {
  if (!profile) return "mssql";
  return profile.driver === "demo" ? profile.dialect : profile.driver;
}

function logicalNameOf(symbol: SqlSymbol): string | undefined {
  return symbol.kind === "table"
    ? symbol.object.logicalName
    : symbol.column.logicalName;
}

/** ホバーとインレイヒントのツールチップ：論理名・物理名・型・コメント */
function symbolMarkdown(symbol: SqlSymbol): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const logical = logicalNameOf(symbol);
  if (symbol.kind === "table") {
    const { object } = symbol;
    const what = object.kind === "view" ? "ビュー" : "テーブル";
    md.appendMarkdown(logical ? `**${escapeMarkdown(logical)}**　` : "");
    md.appendMarkdown(`${code(`${object.schema}.${object.name}`)}（${what}）`);
    if (object.comment) md.appendText(`\n\n${object.comment}`);
  } else {
    const { column, table, isKey } = symbol;
    md.appendMarkdown(logical ? `**${escapeMarkdown(logical)}**　` : "");
    md.appendMarkdown(code(column.name));
    md.appendText(
      `\n${columnTypeLabel(column.type)}${isKey ? "・🔑 主キー" : ""}　${table.logicalName ? `${table.logicalName}（${table.schema}.${table.name}）` : `${table.schema}.${table.name}`} の列`,
    );
    if (column.comment) md.appendText(`\n\n${column.comment}`);
  }
  return md;
}

/** Markdown の記号を文字として出す */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

/** Markdown のコード（中では \ で記号を消せないので、` だけ置き換える） */
function code(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
}
