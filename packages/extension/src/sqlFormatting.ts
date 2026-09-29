// .sql の整形（D-45）。VS Code の「ドキュメントのフォーマット」「選択範囲のフォーマット」と、コマンド「SQL を整形」から使う。
// 方言は、そのファイルの接続（補完と同じ決め方、D-39）。決まらなければ SQL Server。
// ほかの整形の拡張（Prettier SQL など）が既定なら、この拡張を既定にするかを一度だけ聞く

import {
  DEFAULT_FORMAT_OPTIONS,
  formatSql,
  getDialect,
  type SqlFormatOptions,
} from "@sql-editor-tool/core";
import * as vscode from "vscode";
import {
  dialectOf,
  isSqlDocument,
  SQL_SELECTOR,
  type SqlEditing,
} from "./sqlEditing";

const SECTION = "sqlEditorTool.format";
/** 既定のフォーマッタにするかを聞いたか（globalState） */
const ASKED_KEY = "sqlEditorTool.formatterAsked";
/** :名前 を分けてしまう、よく使われる整形の拡張 */
const PRETTIER_SQL = "inferrinizzard.prettier-sql-vscode";

type Settings = Omit<SqlFormatOptions, "tabWidth" | "useTabs">;

/** 整形の設定（sqlEditorTool.format.*）。「SQL を生成」（D-49）も、AND の位置をこれに合わせる */
export function formatSettings(): Settings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const d = DEFAULT_FORMAT_OPTIONS;
  return {
    keywordCase: config.get("keywordCase", d.keywordCase),
    logicalOperatorNewline: config.get(
      "logicalOperatorNewline",
      d.logicalOperatorNewline,
    ),
    expressionWidth: config.get("expressionWidth", d.expressionWidth),
    linesBetweenQueries: config.get(
      "linesBetweenQueries",
      d.linesBetweenQueries,
    ),
    denseOperators: config.get("denseOperators", d.denseOperators),
    newlineBeforeSemicolon: config.get(
      "newlineBeforeSemicolon",
      d.newlineBeforeSemicolon,
    ),
  };
}

export class SqlFormatting
  implements
    vscode.DocumentFormattingEditProvider,
    vscode.DocumentRangeFormattingEditProvider,
    vscode.Disposable
{
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly editing: SqlEditing,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.disposables.push(
      vscode.languages.registerDocumentFormattingEditProvider(
        SQL_SELECTOR,
        this,
      ),
      vscode.languages.registerDocumentRangeFormattingEditProvider(
        SQL_SELECTOR,
        this,
      ),
      vscode.commands.registerCommand("sqlEditorTool.formatSql", () =>
        this.formatActiveEditor(),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.askDefaultFormatter(editor?.document),
      ),
    );
    void this.askDefaultFormatter(vscode.window.activeTextEditor?.document);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    const text = document.getText();
    const formatted = this.format(document, text, options, true);
    if (formatted === null || formatted === normalizeEol(text)) return [];
    const all = new vscode.Range(
      document.positionAt(0),
      document.positionAt(text.length),
    );
    return [vscode.TextEdit.replace(all, formatted)];
  }

  /** 選んだ範囲（行の単位に広げる）を整形し、最初の行の字下げに合わせる */
  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
  ): vscode.TextEdit[] {
    const lines = new vscode.Range(
      range.start.line,
      0,
      range.end.character === 0 && range.end.line > range.start.line
        ? range.end.line - 1
        : range.end.line,
      Number.MAX_SAFE_INTEGER,
    );
    const whole = document.validateRange(lines);
    const text = document.getText(whole);
    if (text.trim() === "") return [];
    const indent = /^[ \t]*/.exec(
      text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "",
    )?.[0];
    // 貼り付けたときの整形などでも呼ばれるので、整形できなくてもステータスバーに出すだけにする
    const formatted = this.format(document, text, options, this.explicit);
    if (formatted === null) return [];
    const indented = formatted
      .split("\n")
      .map((line) => (line === "" ? line : `${indent ?? ""}${line}`))
      .join("\n");
    if (indented === normalizeEol(text)) return [];
    return [vscode.TextEdit.replace(whole, indented)];
  }

  /** この起動の間に、既定のフォーマッタにするかを聞いたか */
  private asked = false;

  /** コマンド「SQL を整形」で選んだ範囲を整形しているところか（整形できない理由を目立たせる） */
  private explicit = false;

  /** 整形した文字列。整形できなければ、理由を出して null（loud でなければステータスバーに） */
  private format(
    document: vscode.TextDocument,
    text: string,
    options: vscode.FormattingOptions,
    loud: boolean,
  ): string | null {
    const { profile } = this.editing.connectionFor(document);
    const result = formatSql(getDialect(dialectOf(profile)), text, {
      ...formatSettings(),
      tabWidth: options.tabSize,
      useTabs: !options.insertSpaces,
    });
    if (!result.ok) {
      if (loud) void vscode.window.showWarningMessage(result.message);
      else
        vscode.window.setStatusBarMessage(`$(warning) ${result.message}`, 8000);
      return null;
    }
    if (result.rejoined > 0) {
      vscode.window.setStatusBarMessage(
        `ほかの整形で分かれていた「: 名前」を「:名前」に戻しました（${result.rejoined} か所）`,
        8000,
      );
    }
    return result.text;
  }

  /** コマンド「SQL を整形」：既定のフォーマッタが何であっても、この拡張で整形する（範囲を選んでいればその行だけ） */
  private async formatActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSqlDocument(editor.document)) {
      void vscode.window.showInformationMessage(
        "整形する .sql をエディタで開いてください",
      );
      return;
    }
    const options: vscode.FormattingOptions = {
      tabSize:
        typeof editor.options.tabSize === "number" ? editor.options.tabSize : 2,
      insertSpaces: editor.options.insertSpaces !== false,
    };
    this.explicit = true;
    let edits: vscode.TextEdit[];
    try {
      edits = editor.selection.isEmpty
        ? this.provideDocumentFormattingEdits(editor.document, options)
        : this.provideDocumentRangeFormattingEdits(
            editor.document,
            editor.selection,
            options,
          );
    } finally {
      this.explicit = false;
    }
    if (edits.length === 0) return;
    await editor.edit((builder) => {
      for (const edit of edits) builder.replace(edit.range, edit.newText);
    });
  }

  /**
   * ほかの整形の拡張が既定になっている（か Prettier SQL が入っている）なら、この拡張を .sql の既定のフォーマッタにするかを聞く。
   * ボタンを選んだら、もう聞かない。選ばずに消えたら（通知は 15 秒ほどで隠れる）、次に VS Code を起動したときにもう一度聞く。
   * 変えるのは「この拡張で整形する」を選んだときの、利用者の設定のその言語の editor.defaultFormatter だけ
   */
  private async askDefaultFormatter(
    document: vscode.TextDocument | undefined,
  ): Promise<void> {
    if (!document || !isSqlDocument(document)) return;
    if (this.asked || this.context.globalState.get(ASKED_KEY, false)) return;
    const own = this.context.extension.id;
    const languageId = document.languageId;
    const current = vscode.workspace
      .getConfiguration("editor", { languageId })
      .get<string>("defaultFormatter");
    if (current === own) return;
    if (!current && !vscode.extensions.getExtension(PRETTIER_SQL)) return;
    // この起動の間は、もう聞かない
    this.asked = true;
    const answer = await vscode.window.showInformationMessage(
      ".sql の整形（Shift+Alt+F など）を、この拡張で行いますか？ :名前 や @名前 を分けずに整形します（Prettier SQL などは :名前 を「: 名前」に分けてしまい、入力欄になりません）",
      "この拡張で整形する",
      "今のままにする",
    );
    if (answer === undefined) return;
    await this.context.globalState.update(ASKED_KEY, true);
    if (answer !== "この拡張で整形する") return;
    await vscode.workspace
      .getConfiguration("editor", { languageId })
      .update("defaultFormatter", own, vscode.ConfigurationTarget.Global, true);
    void vscode.window.showInformationMessage(
      `設定しました（ユーザーの設定の "[${languageId}]" の editor.defaultFormatter）。元に戻すときは、設定でこの項目を消してください`,
    );
  }
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
