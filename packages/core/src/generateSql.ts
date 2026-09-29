// テーブルから SELECT 文を作る（D-49。A5:SQL Mk-2 の「SQL の生成」をまねる）。
// 列を 1 行に 1 つ（, は行の終わり）並べ、行の後ろに論理名のコメントを揃えて付ける。
// 形は .sql の整形（D-45）に合わせる（インデントの幅・タブ、AND の位置。整形しても、コメントの前の空白のほかは変わらない）。
// 主キー（なければ列の設定のキー、D-36）の列を :名前 で絞り（実行すると入力欄になる、D-43）、主キーの順に並べる。
// 名前は、引用符が要るもの（予約語・記号・Oracle の小文字を含むもの）だけ囲む（補完と同じ）

import { completionIdentifier } from "./completion";
import type { Dialect } from "./dialect";
import type { SqlFormatOptions } from "./format";
import type { ReportParamType } from "./report";
import type { ColumnInfo, TableRef } from "./schema";
import { displayWidth } from "./textWidth";

export type GenerateSelectOptions = {
  /**
   * 先頭に表の名前をコメントで付ける（-- スキーマ.表（論理名））。A5 の --*DataTitle に当たる。
   * VS Code は名前のないエディタのタブに 1 行目を出すので、どの表の SQL かがタブで分かる
   */
  title: boolean;
  /** キーの列で絞る（WHERE 列 = :列） */
  whereKeys: boolean;
  /** キーの順に並べる（ORDER BY） */
  orderByKeys: boolean;
  /** 列と表の後ろに論理名をコメントで付ける（-- 論理名）。論理名のないものには付けない */
  comments: boolean;
  /** 表の名前にスキーマを付ける（スキーマ.表） */
  qualifySchema: boolean;
};

export const DEFAULT_GENERATE_OPTIONS: GenerateSelectOptions = {
  title: true,
  whereKeys: true,
  orderByKeys: true,
  comments: true,
  qualifySchema: true,
};

export type GenerateSelectInput = {
  table: TableRef;
  /** 表の論理名（D-40） */
  logicalName?: string | undefined;
  /** 列（テーブルの列の順） */
  columns: readonly ColumnInfo[];
  /** キーの列（主キーの順）。主キーがなければ列の設定のキー。どちらもなければ空 */
  keys: readonly string[];
};

/** 形。.sql の整形（D-45）と同じ設定を渡す */
export type GenerateSelectLayout = Pick<
  SqlFormatOptions,
  "tabWidth" | "useTabs" | "logicalOperatorNewline"
>;

/** VS Code の既定（タブの幅 4、スペース）と、整形の既定（AND は行の頭） */
export const DEFAULT_GENERATE_LAYOUT: GenerateSelectLayout = {
  tabWidth: 4,
  useTabs: false,
  logicalOperatorNewline: "before",
};

/** WHERE に書いた入力欄と、比べる列 */
export type GeneratedParam = { name: string; column: ColumnInfo };

export type GeneratedSelect = {
  sql: string;
  params: GeneratedParam[];
};

/** 列の行と論理名のコメントの間の空き（桁） */
const COMMENT_GAP = 4;

export function generateSelect(
  dialect: Dialect,
  input: GenerateSelectInput,
  options: GenerateSelectOptions,
  layout: GenerateSelectLayout = DEFAULT_GENERATE_LAYOUT,
): GeneratedSelect {
  const id = (name: string) => completionIdentifier(dialect, name);
  const indent = layout.useTabs ? "\t" : " ".repeat(layout.tabWidth);
  /** 並べるもの（列・ORDER BY）の , は行の終わり */
  const comma = (i: number, count: number) => (i < count - 1 ? "," : "");
  const { table } = input;
  const byName = new Map(input.columns.map((c) => [c.name, c]));
  const keys = input.keys.flatMap((name) => {
    const column = byName.get(name);
    return column ? [column] : [];
  });

  const lines: { code: string; comment?: string | undefined }[] = [];
  if (options.title) lines.push({ code: `-- ${generatedTitle(input)}` });
  lines.push({ code: "SELECT" });
  if (input.columns.length === 0) {
    lines.push({ code: `${indent}*` });
  }
  for (const [i, column] of input.columns.entries()) {
    lines.push({
      code: `${indent}${id(column.name)}${comma(i, input.columns.length)}`,
      comment: column.logicalName,
    });
  }
  lines.push({ code: "FROM" });
  lines.push({
    code: `${indent}${options.qualifySchema ? `${id(table.schema)}.` : ""}${id(table.name)}`,
    comment: input.logicalName,
  });

  const params: GeneratedParam[] = [];
  if (options.whereKeys && keys.length > 0) {
    const names = new Set<string>();
    lines.push({ code: "WHERE" });
    for (const [i, column] of keys.entries()) {
      const name = paramName(column.name, names);
      params.push({ name, column });
      const condition = `${id(column.name)} = :${name}`;
      lines.push({
        code:
          layout.logicalOperatorNewline === "before"
            ? `${indent}${i === 0 ? "" : "AND "}${condition}`
            : `${indent}${condition}${i < keys.length - 1 ? " AND" : ""}`,
      });
    }
  }
  if (options.orderByKeys && keys.length > 0) {
    lines.push({ code: "ORDER BY" });
    for (const [i, column] of keys.entries()) {
      lines.push({
        code: `${indent}${id(column.name)}${comma(i, keys.length)}`,
      });
    }
  }

  // コメントは、コメントを付ける行のいちばん長い行の後ろに揃える
  const commented = options.comments
    ? lines.filter((line) => line.comment)
    : [];
  const width = (code: string) => displayWidth(code, layout.tabWidth);
  const column =
    Math.max(0, ...commented.map((line) => width(line.code))) + COMMENT_GAP;
  const text = lines.map((line) =>
    options.comments && line.comment
      ? `${line.code}${" ".repeat(column - width(line.code))}-- ${line.comment}`
      : line.code,
  );
  return { sql: `${text.join("\n")}\n`, params };
}

/** 先頭のコメントに書く表の名前（スキーマ.表（論理名）） */
export function generatedTitle(
  input: Pick<GenerateSelectInput, "table" | "logicalName">,
): string {
  const { schema, name } = input.table;
  return `${schema}.${name}${input.logicalName ? `（${input.logicalName}）` : ""}`;
}

/**
 * 入力欄の名前（:名前 の名前）。列名をそのまま使う。
 * 入力欄の名前に使えない文字（Oracle の $ や # など）は _ にし、ほかの入力欄と重なれば番号を付ける
 */
function paramName(columnName: string, used: Set<string>): string {
  let base = [...columnName]
    .map((c) => (/[\p{L}\p{N}_]/u.test(c) ? c : "_"))
    .join("");
  if (!/^[\p{L}_]/u.test(base)) base = `_${base}`;
  let name = base;
  for (let n = 2; used.has(name); n += 1) name = `${base}_${n}`;
  used.add(name);
  return name;
}

/**
 * 入力欄の種類を、比べる列の型から決める。文字列の列は決めない（既定の文字列のまま。SQL Server は推定もする、D-35）
 */
export function paramTypeForColumn(
  column: ColumnInfo,
): ReportParamType | undefined {
  if (column.semantic?.kind === "date") return "ymd";
  switch (column.type.kind) {
    case "number":
      return "number";
    case "datetime":
      return "date";
    default:
      return undefined;
  }
}
