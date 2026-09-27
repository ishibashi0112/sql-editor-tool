// 差分カメラの条件の入力欄（D-48）の、列の候補。打ちかけの語を、列名か論理名で探す

import {
  completionIdentifier,
  type DialectName,
  getDialect,
  isInsideLiteral,
} from "@sql-editor-tool/core";
import type { ConditionColumn } from "@sql-editor-tool/host";

const WORD_PART = /[\p{L}\p{N}_$#]/u;

/** カーソルの前の、打ちかけの語（文字列やコメントの中、数値なら null） */
export function wordBefore(
  dialect: DialectName,
  text: string,
  caret: number,
): { start: number; word: string } | null {
  if (isInsideLiteral(getDialect(dialect), text, caret)) return null;
  let start = caret;
  while (start > 0 && WORD_PART.test(text.charAt(start - 1))) start -= 1;
  // [名前] や "名前" の中、別名の後、数値は、候補を出さない
  const before = text.charAt(start - 1);
  if (before === "[" || before === '"' || before === ".") return null;
  if (/^\p{N}/u.test(text.slice(start, caret))) return null;
  return { start, word: text.slice(start, caret) };
}

/**
 * 語に合う列（名前の先頭 → 論理名の先頭 → 名前の途中 → 論理名の途中の順）。
 * all なら、語が空でも全部の列。打ち終わった名前（大文字小文字を問わず同じ）だけなら出さない
 */
export function suggestColumns(
  columns: readonly ConditionColumn[],
  word: string,
  options: { all?: boolean; max?: number } = {},
): ConditionColumn[] {
  const max = options.max ?? 50;
  const w = word.toUpperCase();
  if (w === "") return options.all ? columns.slice(0, max) : [];
  const rank = (c: ConditionColumn): number => {
    const name = c.name.toUpperCase();
    const logical = c.logicalName?.toUpperCase() ?? "";
    if (name.startsWith(w)) return 0;
    if (logical.startsWith(w)) return 1;
    if (name.includes(w)) return 2;
    if (logical.includes(w)) return 3;
    return -1;
  };
  const matched = columns
    .map((column, index) => ({ column, index, rank: rank(column) }))
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((m) => m.column);
  if (
    !options.all &&
    matched.length === 1 &&
    matched[0]?.name.toUpperCase() === w
  ) {
    return [];
  }
  return matched.slice(0, max);
}

/** 打ちかけの語を列名に置き換える（引用符が要る名前は囲む） */
export function insertColumn(
  dialect: DialectName,
  text: string,
  start: number,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const inserted = completionIdentifier(getDialect(dialect), name);
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  };
}
