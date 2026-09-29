// テーブルから SQL を作る（D-49。A5:SQL Mk-2 の「SQL の生成」をまねる）。SELECT・INSERT・UPDATE・DELETE を作る。
// 列を 1 行に 1 つ（, は行の終わり）並べ、行の後ろに論理名のコメントを揃えて付ける。値は :名前 にする
// （SELECT は実行すると入力欄になる、D-43。INSERT・UPDATE・DELETE はこのツールでは実行しない（読み取り専用）ので、
// A5 やプログラムに貼って使う）。主キー（なければ列の設定のキー、D-36）の列で絞る。
// 形は .sql の整形（D-45）に合わせる（インデントの幅・タブ、AND の位置、括弧の中を 1 行にまとめる幅）。
// 整形しても、コメントの前の空白のほかは変わらない。
// 名前は、引用符が要るもの（予約語・記号・Oracle の小文字を含むもの）だけ囲む（補完と同じ）

import { completionIdentifier } from "./completion";
import type { Dialect } from "./dialect";
import { DEFAULT_FORMAT_OPTIONS, type SqlFormatOptions } from "./format";
import type { ReportParamType } from "./report";
import type { ColumnInfo, TableRef } from "./schema";
import { displayWidth } from "./textWidth";

/** 作る SQL の種類 */
export type GenerateKind = "select" | "insert" | "update" | "delete";

export type GenerateOptions = {
  /**
   * 先頭に表の名前をコメントで付ける（-- スキーマ.表（論理名））。A5 の --*DataTitle に当たる。
   * VS Code は名前のないエディタのタブに 1 行目を出すので、どの表の SQL かがタブで分かる
   */
  title: boolean;
  /** キーの列で絞る（WHERE 列 = :列）。SELECT だけ（UPDATE・DELETE はいつも絞る） */
  whereKeys: boolean;
  /** キーの順に並べる（ORDER BY）。SELECT だけ */
  orderByKeys: boolean;
  /** 列と表の後ろに論理名をコメントで付ける（-- 論理名）。論理名のないものには付けない */
  comments: boolean;
  /** 表の名前にスキーマを付ける（スキーマ.表） */
  qualifySchema: boolean;
};

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  title: true,
  whereKeys: true,
  orderByKeys: true,
  comments: true,
  qualifySchema: true,
};

/** 種類ごとに選べる付けるもの */
export const GENERATE_OPTION_KEYS: Record<
  GenerateKind,
  readonly (keyof GenerateOptions)[]
> = {
  select: ["title", "whereKeys", "orderByKeys", "comments", "qualifySchema"],
  insert: ["title", "comments", "qualifySchema"],
  update: ["title", "comments", "qualifySchema"],
  delete: ["title", "comments", "qualifySchema"],
};

export type GenerateInput = {
  table: TableRef;
  /** 表の論理名（D-40） */
  logicalName?: string | undefined;
  /** 列（テーブルの列の順） */
  columns: readonly ColumnInfo[];
  /** キーの列（主キーの順）。主キーがなければ列の設定のキー。どちらもなければ空 */
  keys: readonly string[];
};

/** 形。.sql の整形（D-45）と同じ設定を渡す */
export type GenerateLayout = Pick<
  SqlFormatOptions,
  "tabWidth" | "useTabs" | "logicalOperatorNewline" | "expressionWidth"
>;

/** VS Code の既定（タブの幅 4、スペース）と、整形の既定（AND は行の頭、括弧の中は 50 文字まで 1 行） */
export const DEFAULT_GENERATE_LAYOUT: GenerateLayout = {
  tabWidth: 4,
  useTabs: false,
  logicalOperatorNewline: DEFAULT_FORMAT_OPTIONS.logicalOperatorNewline,
  expressionWidth: DEFAULT_FORMAT_OPTIONS.expressionWidth,
};

/** :名前 で書いた値と、その列 */
export type GeneratedParam = { name: string; column: ColumnInfo };

export type GeneratedSql = {
  sql: string;
  params: GeneratedParam[];
};

/** 列の行と論理名のコメントの間の空き（桁） */
const COMMENT_GAP = 4;

type Line = { code: string; comment?: string | undefined };

export function generateSql(
  dialect: Dialect,
  kind: GenerateKind,
  input: GenerateInput,
  options: GenerateOptions,
  layout: GenerateLayout = DEFAULT_GENERATE_LAYOUT,
): GeneratedSql {
  const id = (name: string) => completionIdentifier(dialect, name);
  const indent = layout.useTabs ? "\t" : " ".repeat(layout.tabWidth);
  /** 並べるもの（列・値・SET・ORDER BY）の , は行の終わり */
  const comma = (i: number, count: number) => (i < count - 1 ? "," : "");
  const { table, columns } = input;
  const tableName = `${options.qualifySchema ? `${id(table.schema)}.` : ""}${id(table.name)}`;
  const byName = new Map(columns.map((c) => [c.name, c]));
  const keys = input.keys.flatMap((name) => {
    const column = byName.get(name);
    return column ? [column] : [];
  });
  const params: GeneratedParam[] = [];
  const used = new Set<string>();
  const param = (column: ColumnInfo) => {
    const name = paramName(column.name, used);
    params.push({ name, column });
    return `:${name}`;
  };
  /** キーで絞る WHERE。キーがなければ、条件を書いてもらうコメント（そのままでは実行できない） */
  const where = (missing: string): Line[] => {
    if (keys.length === 0) {
      return [
        { code: "WHERE" },
        {
          code: `${indent}-- 主キーがありません。${missing}の条件を書いてください`,
        },
      ];
    }
    return [
      { code: "WHERE" },
      ...keys.map((column, i) => {
        const condition = `${id(column.name)} = ${param(column)}`;
        return {
          code:
            layout.logicalOperatorNewline === "before"
              ? `${indent}${i === 0 ? "" : "AND "}${condition}`
              : `${indent}${condition}${i < keys.length - 1 ? " AND" : ""}`,
        };
      }),
    ];
  };
  /**
   * 括弧の中の並び（INSERT の列と値）。整形と同じく、コメントがなく中身が expressionWidth より短ければ 1 行にする。
   * そうでなければ 1 行に 1 つ（括弧の中は 1 段深く）
   */
  const parenthesized = (
    head: string,
    items: readonly Line[],
    headComment: string | undefined,
  ): Line[] => {
    const content = items.map((item) => item.code).join(", ");
    const commented = options.comments && items.some((item) => item.comment);
    if (!commented && content.length < layout.expressionWidth) {
      return [{ code: `${head}(${content})`, comment: headComment }];
    }
    return [
      { code: `${head}(`, comment: headComment },
      ...items.map((item, i) => ({
        code: `${indent}${indent}${item.code}${comma(i, items.length)}`,
        comment: item.comment,
      })),
      { code: `${indent})` },
    ];
  };

  const lines: Line[] = [];
  if (options.title) lines.push({ code: `-- ${generatedTitle(input)}` });
  switch (kind) {
    case "select": {
      lines.push({ code: "SELECT" });
      if (columns.length === 0) lines.push({ code: `${indent}*` });
      for (const [i, column] of columns.entries()) {
        lines.push({
          code: `${indent}${id(column.name)}${comma(i, columns.length)}`,
          comment: column.logicalName,
        });
      }
      lines.push({ code: "FROM" });
      lines.push({ code: `${indent}${tableName}`, comment: input.logicalName });
      if (options.whereKeys && keys.length > 0) lines.push(...where(""));
      if (options.orderByKeys && keys.length > 0) {
        lines.push({ code: "ORDER BY" });
        for (const [i, column] of keys.entries()) {
          lines.push({
            code: `${indent}${id(column.name)}${comma(i, keys.length)}`,
          });
        }
      }
      break;
    }
    case "insert": {
      lines.push({ code: "INSERT INTO" });
      lines.push(
        ...parenthesized(
          `${indent}${tableName} `,
          columns.map((c) => ({ code: id(c.name), comment: c.logicalName })),
          input.logicalName,
        ),
      );
      lines.push({ code: "VALUES" });
      lines.push(
        ...parenthesized(
          indent,
          columns.map((c) => ({ code: param(c), comment: c.logicalName })),
          undefined,
        ),
      );
      break;
    }
    case "update": {
      // キーのほかの列を変える（キーしかない表では、すべての列）
      const keyNames = new Set(keys.map((c) => c.name));
      const others = columns.filter((c) => !keyNames.has(c.name));
      const set = others.length > 0 ? others : columns;
      lines.push({ code: `UPDATE ${tableName}`, comment: input.logicalName });
      lines.push({ code: "SET" });
      for (const [i, column] of set.entries()) {
        lines.push({
          code: `${indent}${id(column.name)} = ${param(column)}${comma(i, set.length)}`,
          comment: column.logicalName,
        });
      }
      lines.push(...where("変える行"));
      break;
    }
    case "delete": {
      lines.push({
        code: `DELETE FROM ${tableName}`,
        comment: input.logicalName,
      });
      lines.push(...where("消す行"));
      break;
    }
  }

  // コメントは、コメントを付ける行のいちばん長い行の後ろに揃える
  const width = (code: string) => displayWidth(code, layout.tabWidth);
  const commented = options.comments
    ? lines.filter((line) => line.comment)
    : [];
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
  input: Pick<GenerateInput, "table" | "logicalName">,
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
