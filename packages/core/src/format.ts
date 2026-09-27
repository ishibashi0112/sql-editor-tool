// .sql の整形（D-45）。sql-formatter（MIT）の SQL Server・Oracle の方言を使う。
// ほかの整形の拡張（同じ sql-formatter を使うもの）は、SQL Server の :名前 を「: 名前」に分けてしまい、入力欄（D-28）に
// ならなかった。ここでは :名前 と @名前 をパラメータとして扱わせる。
// 守り：整形の前と後で、空白・改行と大文字小文字のほかに違いがないことを字句で確かめ、違えば整形しない（SQL の意味を変えない）

import { formatDialect, plsql, transactsql } from "sql-formatter";
import { tokenize } from "./baseSql";
import { isReservedWord, scan, separatorLines } from "./completion";
import type { Dialect } from "./dialect";

export type SqlFormatOptions = {
  /** インデントの幅（エディタの設定） */
  tabWidth: number;
  /** インデントにタブを使うか（エディタの設定） */
  useTabs: boolean;
  /** キーワードの大文字・小文字（preserve は書いたまま） */
  keywordCase: "preserve" | "upper" | "lower";
  /** AND・OR を行の頭（before）に置くか、行の終わり（after）に置くか */
  logicalOperatorNewline: "before" | "after";
  /** 括弧の中をこの幅までなら 1 行にまとめる */
  expressionWidth: number;
  /** ; で区切った文の間の空行の数 */
  linesBetweenQueries: number;
  /** 演算子の前後に空白を入れない */
  denseOperators: boolean;
  /** ; の前で改行する */
  newlineBeforeSemicolon: boolean;
};

/** 既定の整形の仕方（Prettier SQL VSCode の既定と同じ。乗り換えても見た目が大きく変わらないように） */
export const DEFAULT_FORMAT_OPTIONS: SqlFormatOptions = {
  tabWidth: 2,
  useTabs: false,
  keywordCase: "preserve",
  logicalOperatorNewline: "before",
  expressionWidth: 50,
  linesBetweenQueries: 1,
  denseOperators: false,
  newlineBeforeSemicolon: false,
};

export type SqlFormatResult =
  | {
      ok: true;
      text: string;
      /** ほかの整形の拡張で分かれていた「: 名前」を「:名前」に戻した数 */
      rejoined: number;
    }
  | { ok: false; message: string };

/**
 * SQL を整形する。GO（SQL Server）や /（Oracle）だけの行はそのまま残し、その間を 1 つずつ整形する
 * （sql-formatter は / の行を前の行に付けてしまうため）
 */
export function formatSql(
  dialect: Dialect,
  text: string,
  options: Partial<SqlFormatOptions> = {},
): SqlFormatResult {
  const settings = { ...DEFAULT_FORMAT_OPTIONS, ...options };
  const { text: source, rejoined } = rejoinSplitParams(dialect, text);
  let formatted: string;
  try {
    formatted = formatChunks(dialect, source, settings);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  let difference: string | null;
  try {
    difference = firstDifference(dialect, source, formatted);
  } catch (error) {
    // 閉じていない文字列・括弧など（sql-formatter が読めても、実行の字句の読み方で読めないもの）
    return {
      ok: false,
      message: `整形しませんでした：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (difference !== null) {
    return {
      ok: false,
      message: `整形すると SQL の中身が変わってしまうので、整形しませんでした（${difference}）`,
    };
  }
  return { ok: true, text: formatted, rejoined };
}

/**
 * ほかの整形の拡張で分かれた「: 名前」（例：BETWEEN: 開始）を「:名前」に戻す。
 * 文字列・コメントの外で、: の後に空白（改行は除く）と名前が続くものだけ。:: や、後ろが予約語のもの（ラベルなど）は戻さない
 */
export function rejoinSplitParams(
  dialect: Dialect,
  text: string,
): { text: string; rejoined: number } {
  const { tokens } = scan(dialect, text);
  const cuts: { from: number; to: number }[] = [];
  for (const [i, t] of tokens.entries()) {
    const name = tokens[i + 1];
    if (t.text !== ":" || !name || name.kind !== "word") continue;
    if (tokens[i - 1]?.text === ":" && tokens[i - 1]?.end === t.start) continue;
    const gap = text.slice(t.end, name.start);
    if (!/^[ \t]+$/.test(gap)) continue;
    if (!/^[\p{L}_]/u.test(name.text) || isReservedWord(name.text)) continue;
    cuts.push({ from: t.end, to: name.start });
  }
  let result = text;
  for (const cut of cuts.reverse()) {
    result = result.slice(0, cut.from) + result.slice(cut.to);
  }
  return { text: result, rejoined: cuts.length };
}

function formatChunks(
  dialect: Dialect,
  text: string,
  settings: SqlFormatOptions,
): string {
  const blank = "\n".repeat(settings.linesBetweenQueries + 1);
  let output = "";
  const append = (piece: string, gap: string) => {
    if (piece !== "") output += (output === "" ? "" : gap) + piece;
  };
  let from = 0;
  for (const separator of separatorLines(dialect, text)) {
    append(formatChunk(dialect, text, from, separator.start, settings), blank);
    // 区切りの行は前の文のすぐ次の行に置き、次の文との間は ; で区切った文と同じだけ空ける
    append(text.slice(separator.start, separator.end), "\n");
    from = separator.end;
  }
  append(formatChunk(dialect, text, from, text.length, settings), blank);
  return /\n\s*$/.test(text) ? `${output}\n` : output;
}

function formatChunk(
  dialect: Dialect,
  text: string,
  from: number,
  to: number,
  settings: SqlFormatOptions,
): string {
  const chunk = text.slice(from, to);
  if (chunk.trim() === "") return "";
  const { tabWidth, useTabs, ...rest } = settings;
  try {
    return formatDialect(chunk, {
      ...(dialect.name === "oracle"
        ? { dialect: plsql }
        : {
            dialect: transactsql,
            // SQL Server でも :名前 を入力欄に使う（D-28）。@名前 は BI ツールの SQL の書き方（D-43）
            paramTypes: { named: [":", "@"], quoted: ["@"] },
          }),
      tabWidth,
      useTabs,
      ...rest,
    });
  } catch (error) {
    throw new Error(parseErrorMessage(error, text, from));
  }
}

/** sql-formatter の読めなかった位置（塊の中の行）を、ファイルの行にして伝える */
function parseErrorMessage(error: unknown, text: string, from: number): string {
  const message = error instanceof Error ? error.message : String(error);
  const at = /Unexpected "(.*?)" at line (\d+) column (\d+)/s.exec(message);
  if (!at) {
    return `SQL を読めなかったので、整形しませんでした（${message.split("\n")[0]}）`;
  }
  const line = lineOf(text, from) + Number(at[2]) - 1;
  const near = (at[1] ?? "").split("\n")[0]?.trim() ?? "";
  return `${line} 行目の「${near}」のところで SQL を読めなかったので、整形しませんでした`;
}

/** 位置の行番号（1 から） */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; ) {
    line += 1;
    i = text.indexOf("\n", i + 1);
  }
  return line;
}

/**
 * 整形の前と後の違い。字句（文字列・名前・:名前 などはそのまま、キーワードと名前は大文字小文字を区別しない）と、
 * コメント（空白の違いは無視）が同じなら null
 */
export function firstDifference(
  dialect: Dialect,
  before: string,
  after: string,
): string | null {
  const a = tokenize(dialect, before);
  const b = tokenize(dialect, after);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    const same =
      x !== undefined &&
      y !== undefined &&
      x.kind === y.kind &&
      (x.kind === "word"
        ? x.text.toUpperCase() === y.text.toUpperCase()
        : x.text === y.text);
    if (!same) {
      const at = x ?? a.at(-1);
      return at
        ? `${lineOf(before, at.start)} 行目の「${at.text}」のあたり`
        : "SQL の終わり";
    }
  }
  // GO や / の行は、改行を含めて残っていること（sql-formatter は / の行を前の行に付けてしまう）
  if (
    separatorLines(dialect, before).length !==
    separatorLines(dialect, after).length
  ) {
    return "GO や / だけの行";
  }
  const ca = comments(dialect, before);
  const cb = comments(dialect, after);
  for (let i = 0; i < Math.max(ca.length, cb.length); i += 1) {
    if (ca[i]?.text !== cb[i]?.text) {
      const at = ca[i];
      return at ? `${lineOf(before, at.start)} 行目のコメント` : "コメント";
    }
  }
  return null;
}

/** コメントの中身（空白の並びは 1 つにまとめる） */
function comments(
  dialect: Dialect,
  text: string,
): { text: string; start: number }[] {
  return scan(dialect, text)
    .opaque.filter(
      (o) => text.startsWith("--", o.start) || text.startsWith("/*", o.start),
    )
    .map((o) => ({
      text: text.slice(o.start, o.end).replace(/\s+/g, " ").trim(),
      start: o.start,
    }));
}
