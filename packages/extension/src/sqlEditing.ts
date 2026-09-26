// .sql の編集の支援（D-39）：テーブル名・列名・キーワードの入力補完と、補完に使う接続を選ぶステータスバー。
// レポートの .sql（先頭に設定のコメントがあるもの、レポートのフォルダの中のもの）は、先頭のコメントの接続を使う（D-29）。
// それ以外の .sql は、ファイルごとに選んだ接続を VS Code の中に覚えておく。未接続なら、補完のときに接続する

import { isAbsolute, relative } from "node:path";
import {
  type DialectName,
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
import { reportsFolder } from "./reports";
import type { SessionManager } from "./sessions";
import { describe } from "./tree";

/** レポートでない .sql の、ファイル（URI）→ 接続名 */
const FILE_CONNECTIONS_KEY = "sqlEditorTool.sqlConnections";

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
        { language: "sql" },
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
  private profileFor(document: vscode.TextDocument): {
    name: string | null;
    profile: ConnectionProfile | undefined;
  } {
    const name = this.isReport(document)
      ? (parseReportConfig(document.getText()).config.connection ?? null)
      : (this.fileConnections()[document.uri.toString()] ?? null);
    return {
      name,
      profile: name
        ? this.store.list().find((p) => p.name === name)
        : undefined,
    };
  }

  /** レポートの .sql か（先頭に設定のコメントがある、またはレポートのフォルダの中にある） */
  private isReport(document: vscode.TextDocument): boolean {
    if (hasReportHeader(document.getText())) return true;
    const folder = reportsFolder();
    if (!folder || document.uri.scheme !== "file") return false;
    const rel = relative(folder.fsPath, document.uri.fsPath);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
    const dialect: DialectName = profile
      ? profile.driver === "demo"
        ? profile.dialect
        : profile.driver
      : "mssql";
    try {
      const entries = await completeSql({
        dialect,
        text: document.getText(),
        offset: document.offsetAt(position),
        cache: profile ? this.cacheFor(profile) : null,
      });
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
    if (document?.languageId !== "sql") {
      this.status.hide();
      return;
    }
    const { name, profile } = this.profileFor(document);
    if (profile) {
      this.status.text = `$(database) ${profile.name}`;
      this.status.tooltip = `SQL の補完に使う接続：${profile.name}（${describe(profile)}）。クリックで変える`;
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

  /** 補完に使う接続を選ぶ。レポートは先頭のコメントに書き、それ以外はファイルごとに覚える */
  private async choose(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (document?.languageId !== "sql") return;
    const profiles = this.store.list();
    if (profiles.length === 0) {
      void vscode.window.showWarningMessage(
        "接続がありません。サイドバーの「接続」で接続を追加してください",
      );
      return;
    }
    const report = this.isReport(document);
    const current = this.profileFor(document).name;
    const none = { label: "（使わない）", profile: undefined };
    const picked = await vscode.window.showQuickPick(
      [
        ...profiles.map((profile) => ({
          label: profile.name,
          description: `${describe(profile)}${profile.name === current ? " · 選択中" : ""}`,
          profile,
        })),
        ...(current && !report ? [none] : []),
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
      if (picked.profile) map[key] = picked.profile.name;
      else delete map[key];
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
