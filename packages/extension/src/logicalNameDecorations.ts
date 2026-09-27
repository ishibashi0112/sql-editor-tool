// .sql の論理名の見た目（D-42）。VS Code のインレイヒントは拡張から色や大きさを変えられず、コードと見分けにくかったので、
// エディタの装飾（decoration）で名前の後ろに出す。見た目は設定 sqlEditorTool.logicalNames.style で選ぶ。
// 色は拡張の色（package.json の colors）にしてあり、テーマや workbench.colorCustomizations で変えられる

import { shortLogicalName } from "@sql-editor-tool/core";
import type { SqlSymbol } from "@sql-editor-tool/host";
import * as vscode from "vscode";
import {
  cursorLines,
  isSqlDocument,
  type LogicalNameStyle,
  logicalNameOf,
  logicalNamePrefs,
  type SqlEditing,
  symbolMarkdown,
} from "./sqlEditing";

type DecoratedStyle = Exclude<LogicalNameStyle, "inlayHint">;

/** 見えている範囲の前後に、少し余分に取る行数（スクロールしたときにすぐ出るように） */
const MARGIN_LINES = 20;

const color = (id: string) => new vscode.ThemeColor(`sqlEditorTool.${id}`);

/**
 * 見た目ごとの装飾。font-size などは textDecoration に書き足す（VS Code の API に項目がないため）
 * - subtle：薄い色・斜体・少し小さく（コードと形で見分ける）
 * - bracket：薄い色で ‹論理名› と括る（どこからどこまでが論理名か分かる）
 * - tag：色の付いた小さなラベル（コードではないことがはっきり分かる）
 * - lineEnd：行の終わりにまとめる（コードの中には何も入れない）
 */
function createTypes(): Record<
  DecoratedStyle,
  vscode.TextEditorDecorationType
> {
  const muted = {
    color: color("logicalNameForeground"),
    textDecoration: "none; font-size: 0.85em;",
  };
  return {
    subtle: vscode.window.createTextEditorDecorationType({
      after: { ...muted, fontStyle: "italic", margin: "0 0 0 0.45em" },
    }),
    bracket: vscode.window.createTextEditorDecorationType({
      after: { ...muted, margin: "0 0 0 0.15em" },
    }),
    tag: vscode.window.createTextEditorDecorationType({
      after: {
        color: color("logicalNameTagForeground"),
        backgroundColor: color("logicalNameTagBackground"),
        margin: "0 0 0 0.35em",
        textDecoration:
          "none; font-size: 0.8em; border-radius: 3px; padding: 0 0.4em;",
      },
    }),
    lineEnd: vscode.window.createTextEditorDecorationType({
      after: { ...muted, fontStyle: "italic", margin: "0 0 0 2.5em" },
    }),
  };
}

export class LogicalNameDecorations implements vscode.Disposable {
  private readonly types = createTypes();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<
    vscode.TextEditor,
    ReturnType<typeof setTimeout>
  >();
  /** エディタごとの出し直しの番号（古い結果で上書きしない） */
  private readonly versions = new WeakMap<vscode.TextEditor, number>();

  constructor(private readonly editing: SqlEditing) {
    this.disposables.push(
      ...Object.values(this.types),
      editing.onDidChangeSymbols(() => this.refreshAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) =>
        this.schedule(event.textEditor, 100),
      ),
      vscode.workspace.onDidChangeTextDocument((event) => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === event.document) this.schedule(editor, 300);
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (logicalNamePrefs().show === "cursorLine") {
          this.schedule(event.textEditor, 50);
        }
      }),
    );
    this.refreshAll();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.schedule(editor, 0);
    }
  }

  private schedule(editor: vscode.TextEditor, delayMs: number): void {
    if (!isSqlDocument(editor.document)) return;
    clearTimeout(this.timers.get(editor));
    this.timers.set(
      editor,
      setTimeout(() => {
        this.timers.delete(editor);
        void this.refresh(editor);
      }, delayMs),
    );
  }

  private async refresh(editor: vscode.TextEditor): Promise<void> {
    const version = (this.versions.get(editor) ?? 0) + 1;
    this.versions.set(editor, version);
    const { show, style } = logicalNamePrefs();
    const decorated: DecoratedStyle | null =
      show === "off" || style === "inlayHint" ? null : style;
    let symbols: SqlSymbol[] = [];
    if (decorated) {
      const { document } = editor;
      const [first] = editor.visibleRanges;
      const last = editor.visibleRanges.at(-1);
      if (first && last) {
        const from = document.offsetAt(
          new vscode.Position(Math.max(0, first.start.line - MARGIN_LINES), 0),
        );
        const to = document.offsetAt(
          document.lineAt(
            Math.min(document.lineCount - 1, last.end.line + MARGIN_LINES),
          ).range.end,
        );
        symbols = await this.editing.logicalNamesIn(document, from, to);
      }
      if (show === "cursorLine") {
        const lines = cursorLines(document);
        symbols = symbols.filter((s) =>
          lines.has(document.positionAt(s.end).line),
        );
      }
    }
    // その間にもう一度出し直していたら、古い結果は使わない
    if (this.versions.get(editor) !== version) return;
    for (const [name, type] of Object.entries(this.types)) {
      editor.setDecorations(
        type,
        name === decorated ? this.options(editor.document, name, symbols) : [],
      );
    }
  }

  private options(
    document: vscode.TextDocument,
    style: DecoratedStyle,
    symbols: readonly SqlSymbol[],
  ): vscode.DecorationOptions[] {
    if (style === "lineEnd") return lineEndOptions(document, symbols);
    return symbols.map((symbol) => {
      const name = shortLogicalName(logicalNameOf(symbol) ?? "");
      return {
        range: new vscode.Range(
          document.positionAt(symbol.start),
          document.positionAt(symbol.end),
        ),
        hoverMessage: symbolMarkdown(symbol),
        renderOptions: {
          after: { contentText: style === "bracket" ? `‹${name}›` : name },
        },
      };
    });
  }
}

/** 行の終わりに「物理名 論理名」を並べる（同じ行の同じ名前は 1 回だけ） */
function lineEndOptions(
  document: vscode.TextDocument,
  symbols: readonly SqlSymbol[],
): vscode.DecorationOptions[] {
  const byLine = new Map<number, string[]>();
  for (const symbol of symbols) {
    const line = document.positionAt(symbol.end).line;
    const written = document.getText(
      new vscode.Range(
        document.positionAt(symbol.start),
        document.positionAt(symbol.end),
      ),
    );
    const entry = `${written} ${shortLogicalName(logicalNameOf(symbol) ?? "")}`;
    const list = byLine.get(line) ?? [];
    if (!list.includes(entry)) list.push(entry);
    byLine.set(line, list);
  }
  return [...byLine].map(([line, entries]) => {
    const end = document.lineAt(line).range.end;
    return {
      range: new vscode.Range(end, end),
      renderOptions: { after: { contentText: `◂ ${entries.join("　")}` } },
    };
  });
}
