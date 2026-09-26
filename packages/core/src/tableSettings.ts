// テーブルごとの列の設定（D-36）。意味型の上書き（yyyymmdd の文字列を日付として扱う）と、
// 主キーのないテーブル・ビューでのキーの指定。保存はホスト（拡張は VS Code の中）が行う

import { looksLikeDateName } from "./report";
import type { ColumnInfo, SemanticType } from "./schema";

export type TableSettings = {
  /** 列ごとの意味型（列名 → 意味型）。書いていない列は DB の型のまま */
  semantic?: Record<string, SemanticType>;
  /** 主キーの代わりに使うキーの列（主キーのないテーブル・ビューだけ。並びはテーブルの列の順） */
  keyColumns?: string[];
  /** 日付らしい列の案内に「使わない」と答えた */
  suggestionDismissed?: boolean;
};

/** 意味型を「日付（yyyymmdd）」にできる列か（文字列の列だけ） */
export function canBeYmd(column: ColumnInfo): boolean {
  return column.type.kind === "string";
}

/**
 * yyyymmdd の日付らしい列（案内と「⚙ 列」の（候補）に使う）。
 * 長さ 8 の文字列で、名前が日付らしい（開始日、ORDER_YMD、SHIP_DATE、UPD_DT など）もの。意味型を設定済みの列は除く
 */
export function ymdCandidates(columns: readonly ColumnInfo[]): string[] {
  return columns
    .filter(
      (column) =>
        column.type.kind === "string" &&
        column.type.length === 8 &&
        !column.semantic &&
        looksLikeDateName(column.name),
    )
    .map((column) => column.name);
}

/** 保存しておいた設定を、形をそろえて読む。形の違う値は捨てる */
export function sanitizeTableSettings(value: unknown): TableSettings {
  const settings: TableSettings = {};
  if (!isObject(value)) return settings;
  if (isObject(value.semantic)) {
    const semantic: Record<string, SemanticType> = {};
    for (const [name, raw] of Object.entries(value.semantic)) {
      if (isObject(raw) && raw.kind === "date" && raw.format === "yyyymmdd") {
        semantic[name] = { kind: "date", format: "yyyymmdd" };
      }
    }
    if (Object.keys(semantic).length > 0) settings.semantic = semantic;
  }
  if (Array.isArray(value.keyColumns)) {
    const keys = value.keyColumns.filter(
      (key): key is string => typeof key === "string" && key !== "",
    );
    if (keys.length > 0) settings.keyColumns = [...new Set(keys)];
  }
  if (value.suggestionDismissed === true) settings.suggestionDismissed = true;
  return settings;
}

/**
 * 列に設定を当てる。意味型は文字列の列だけ、キーは主キーがないときだけ使う。
 * テーブルにない列の設定は無視する（列を消した・名前を変えたとき）
 */
export function applyTableSettings(
  columns: readonly ColumnInfo[],
  primaryKey: readonly string[],
  settings: TableSettings,
): (ColumnInfo & { isKey: boolean })[] {
  const keys = new Set(
    primaryKey.length > 0 ? primaryKey : (settings.keyColumns ?? []),
  );
  const semantic = settings.semantic ?? {};
  return columns.map((column) => {
    const { semantic: _base, ...rest } = column;
    const own = Object.hasOwn(semantic, column.name)
      ? semantic[column.name]
      : undefined;
    const next = own && canBeYmd(column) ? own : column.semantic;
    return {
      ...rest,
      ...(next ? { semantic: next } : {}),
      isKey: keys.has(column.name),
    };
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
