// .sql の論理名の見た目（D-42）。VS Code のインレイヒントは拡張から色や大きさを変えられず、コードと見分けにくかったので、
// エディタの装飾（decoration）で名前の後ろに出す。見た目は設定 sqlEditorTool.logicalNames.style で選ぶ。
// 色は拡張の色（package.json の colors）にしてあり、テーマや workbench.colorCustomizations で変えられる

import { displayWidth, shortLogicalName } from "@sql-editor-tool/core";
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
/** 装飾 1 つで出す見た目（lineEndTag は札ごとに装飾を分ける） */
type SingleStyle = Exclude<DecoratedStyle, "lineEndTag">;

/** 見えている範囲の前後に、少し余分に取る行数（スクロールしたときにすぐ出るように） */
const MARGIN_LINES = 20;

const color = (id: string) => new vscode.ThemeColor(`sqlEditorTool.${id}`);

/** 札と薄い字の大きさ（エディタの字に対する倍率）。揃えるときの幅の計算にも使う */
const TAG_FONT = 0.8;
const MUTED_FONT = 0.85;

/** 行の終わりに並べる札の数の上限。これより多い分は、最後の札にまとめる */
const TAG_SLOTS = 10;

/**
 * 見た目ごとの装飾。font-size などは textDecoration に書き足す（VS Code の API に項目がないため）
 * - subtle：薄い色・斜体・少し小さく（コードと形で見分ける）
 * - bracket：薄い色で ‹論理名› と括る（どこからどこまでが論理名か分かる）
 * - tag：色の付いた小さなラベル（コードではないことがはっきり分かる）
 * - lineEnd：行の終わりにまとめる（コードの中には何も入れない）
 * - lineEndTag：行の終わりに、列ごとの色の付いた札で並べる（既定。コードの形はそのままで、見分けやすい）
 * 行の終わりの位置（margin）は、揃えるために装飾ごとに決める
 */
function createTypes(): Record<SingleStyle, vscode.TextEditorDecorationType> {
  const muted = {
    color: color("logicalNameForeground"),
    textDecoration: `none; font-size: ${MUTED_FONT}em;`,
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
      after: { ...muted, fontStyle: "italic" },
    }),
  };
}

/**
 * lineEndTag の札の装飾。札の順番ごとに種類を分ける。
 * VS Code は同じ位置の装飾を CSS のクラス名の順に並べ、クラス名は「種類の key と、装飾ごとの見た目から作る値」なので、
 * 1 つの種類にまとめると札の並びが決まらない（書いた順と入れ替わる）。種類の key の順が作った順になるよう、
 * key の桁が変わるところ（…9 と …10 など）に掛かったら作り直す
 */
function createTagSlotTypes(): vscode.TextEditorDecorationType[] {
  const options: vscode.DecorationRenderOptions = {
    after: {
      color: color("logicalNameTagForeground"),
      backgroundColor: color("logicalNameTagBackground"),
      textDecoration: `none; font-size: ${TAG_FONT}em; border-radius: 3px; padding: 0 0.45em;`,
    },
  };
  for (;;) {
    const types = Array.from({ length: TAG_SLOTS }, () =>
      vscode.window.createTextEditorDecorationType(options),
    );
    const keys = types.map((t) => t.key);
    const ordered = keys.every(
      (key, i) =>
        key.length === keys[0]?.length &&
        (i === 0 || (keys[i - 1] ?? "") < key),
    );
    if (ordered) return types;
    for (const t of types) t.dispose();
  }
}

export class LogicalNameDecorations implements vscode.Disposable {
  private readonly types = createTypes();
  private readonly tagSlots = createTagSlotTypes();
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
      ...this.tagSlots,
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
    for (const [name, type] of Object.entries(this.types) as [
      SingleStyle,
      vscode.TextEditorDecorationType,
    ][]) {
      editor.setDecorations(
        type,
        name === decorated ? this.options(editor, name, symbols) : [],
      );
    }
    const tags =
      decorated === "lineEndTag" ? this.lineEnd(editor, symbols, true) : [];
    for (const [i, type] of this.tagSlots.entries()) {
      editor.setDecorations(type, tags[i] ?? []);
    }
  }

  /** 行の終わりに出すもの（札の順番ごと） */
  private lineEnd(
    editor: vscode.TextEditor,
    symbols: readonly SqlSymbol[],
    tags: boolean,
  ): vscode.DecorationOptions[][] {
    const tabSize = editor.options.tabSize;
    return lineEndOptions(editor.document, symbols, {
      tags,
      slots: TAG_SLOTS,
      align: logicalNamePrefs().align,
      tabSize: typeof tabSize === "number" ? tabSize : 4,
    });
  }

  private options(
    editor: vscode.TextEditor,
    style: SingleStyle,
    symbols: readonly SqlSymbol[],
  ): vscode.DecorationOptions[] {
    const { document } = editor;
    if (style === "lineEnd") {
      return this.lineEnd(editor, symbols, false)[0] ?? [];
    }
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

/** 揃える位置の上限（桁）。これより長い行は、行のすぐ後ろに出す */
const ALIGN_MAX = 100;
/** コードと論理名の間の最小の空き（桁） */
const GAP = 3;

/**
 * 行の終わりに「物理名 論理名」を書いた順に並べる（同じ行の同じ名前は 1 回だけ）。
 * tags なら 1 つずつ札にし、札の順番（slots まで）ごとに分けて返す。そうでなければ 1 つにまとめる。
 * align なら、空行で区切ったひとかたまりの行ごとに、いちばん長い行の後ろに縦に揃える
 */
function lineEndOptions(
  document: vscode.TextDocument,
  symbols: readonly SqlSymbol[],
  options: { tags: boolean; slots: number; align: boolean; tabSize: number },
): vscode.DecorationOptions[][] {
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
  const width = (line: number) =>
    displayWidth(document.lineAt(line).text.trimEnd(), options.tabSize);
  const alignColumn = new Map<number, number>();
  if (options.align) {
    for (const line of byLine.keys()) {
      if (alignColumn.has(line)) continue;
      // 空行で区切ったかたまりの中の、論理名を出す行
      let first = line;
      while (first > 0 && !document.lineAt(first - 1).isEmptyOrWhitespace) {
        first -= 1;
      }
      let last = line;
      while (
        last < document.lineCount - 1 &&
        !document.lineAt(last + 1).isEmptyOrWhitespace
      ) {
        last += 1;
      }
      const lines = [...byLine.keys()].filter((l) => l >= first && l <= last);
      const column = Math.min(
        ALIGN_MAX,
        Math.max(...lines.map((l) => width(l))),
      );
      for (const l of lines) alignColumn.set(l, column);
    }
  }
  const font = options.tags ? TAG_FONT : MUTED_FONT;
  const slots: vscode.DecorationOptions[][] = [];
  for (const [line, entries] of byLine) {
    const end = document.lineAt(line).range.end;
    const range = new vscode.Range(end, end);
    const pad = Math.max(GAP, (alignColumn.get(line) ?? 0) + GAP - width(line));
    // ch は装飾の字の大きさの幅なので、エディタの字の幅にそろえる
    const first = `0 0 0 calc(${pad}ch / ${font})`;
    const texts = options.tags
      ? [
          ...entries.slice(0, options.slots - 1),
          ...(entries.length >= options.slots
            ? [entries.slice(options.slots - 1).join("　")]
            : []),
        ]
      : [`◂ ${entries.join("　")}`];
    for (const [i, contentText] of texts.entries()) {
      const slot = slots[i] ?? [];
      slot.push({
        range,
        renderOptions: {
          after: { contentText, margin: i === 0 ? first : "0 0 0 0.5em" },
        },
      });
      slots[i] = slot;
    }
  }
  return slots;
}
