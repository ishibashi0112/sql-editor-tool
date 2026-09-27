// .sql の編集の支援（D-39）：テーブル名・列名・キーワードの入力補完と、補完に使う接続を選ぶステータスバー。
// 先頭にレポートの設定のコメントがある .sql は、そのコメントの接続を使う（D-29）。
// それ以外の .sql は、ファイルごとに選んだ接続を VS Code の中に覚えておく（ファイルには書かない）。
// 選んでいなければ、つないでいる接続が 1 つならそれを使う。未接続なら、補完のときに接続する。
// ほかの拡張機能が .sql を別の言語（ID が sql でないもの）として扱うことがあるので、拡張子でも判定する

import {
  completionContext,
  type DialectName,
  getDialect,
  hasReportHeader,
  parseReportConfig,
  writeReportConfig,
} from "@sql-editor-tool/core";
import {
  type CompletionEntry,
  completeSql,
  SchemaCache,
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
const SELECTOR: vscode.DocumentSelector = [
  { language: "sql" },
  { pattern: "**/*.sql" },
  { pattern: "**/*.SQL" },
];

function isSqlDocument(document: vscode.TextDocument | undefined): boolean {
  if (!document) return false;
  return document.languageId === "sql" || /\.sql$/i.test(document.uri.path);
}

/** この .sql の補完に使う接続。auto は、選んでいないので自動で決めたもの */
type Resolved = {
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
        SELECTOR,
        {
          provideCompletionItems: (document, position) =>
            this.complete(document, position),
        },
        ".",
      ),
      vscode.commands.registerCommand("sqlEditorTool.chooseSqlConnection", () =>
        this.choose(),
      ),
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
      // つないでいる接続が変わると、自動で選ぶ接続も変わる
      sessions.onDidChange(() => this.updateStatus()),
    );
    this.updateStatus();
  }

  /** 覚えたテーブルの一覧と列を捨てる（「最新の情報に更新」・切断のとき）。id を省くとすべて */
  clear(profileId?: string): void {
    for (const [id, cache] of this.caches) {
      if (profileId === undefined || id === profileId) cache.clear();
    }
    if (profileId === undefined) this.warned.clear();
    else this.warned.delete(profileId);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  /** この .sql の補完に使う接続 */
  private profileFor(document: vscode.TextDocument): Resolved {
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

  private cacheFor(profile: ConnectionProfile): SchemaCache {
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
  ): Promise<vscode.CompletionItem[]> {
    const { profile } = this.profileFor(document);
    const offset = document.offsetAt(position);
    const dialect: DialectName = profile
      ? profile.driver === "demo"
        ? profile.dialect
        : profile.driver
      : "mssql";
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
        return [chooseItem(), ...entries.map(toItem)];
      }
      return entries.map(toItem);
    } catch (error) {
      if (profile && !this.warned.has(profile.id)) {
        this.warned.add(profile.id);
        void vscode.window.showWarningMessage(
          `補完のために「${profile.name}」の情報を取れませんでした：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return [];
    }
  }

  private updateStatus(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !isSqlDocument(document)) {
      this.status.hide();
      return;
    }
    const { name, profile, auto } = this.profileFor(document);
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
    const resolved = this.profileFor(document);
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
  // 主キーの列は 🔑 を付ける（絞り込みは名前だけで行う）
  const label = entry.kind === "key" ? `🔑 ${entry.label}` : entry.label;
  const item = new vscode.CompletionItem(
    { label, description: entry.detail },
    KINDS[entry.kind],
  );
  item.insertText = entry.insertText;
  item.sortText = entry.sortText;
  item.filterText = entry.label;
  return item;
}
