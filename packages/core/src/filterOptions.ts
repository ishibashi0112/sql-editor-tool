// 集合フィルタの候補値。グリッドの getFilterOptions に返す（docs/handover.md §6、§11.5、D-16）。
// 候補はほかの列の条件で絞る（Excel と同じ）。候補を取る列自身の条件は、グリッドが取得した候補に当てる

import { ymdToDateKey } from "./dateKey";
import { type Dialect, type DialectName, getDialect } from "./dialect";
import { QueryBuildError } from "./errors";
import type { ColumnFilterValue } from "./filter";
import type { ColumnInfo, TableRef } from "./schema";
import { type BuiltQuery, checkLimit, finish, fromTable } from "./select";
import { join, Param, raw, type Sql, sql } from "./sql";
import { buildConditions, type ConditionOptions } from "./where";

/** グリッドの GridSelectFilterOption と同じ形 */
export type FilterOption = { label: string; value: string };

/** グリッドの GetFilterOptionsResult と同じ形 */
export type FilterOptionsResult = {
  options: FilterOption[];
  /** 上限で打ち切ったか。グリッドは「先頭のみ・打ち切り」と表示する */
  truncated: boolean;
};

export type FilterOptionsQueryInput = ConditionOptions & {
  dialect: DialectName;
  table: TableRef;
  columns: readonly ColumnInfo[];
  /** 候補を取る列 */
  columnKey: string;
  /** ほかの列のフィルタ。候補を取る列の分が入っていても使わない */
  filters?: Readonly<Record<string, ColumnFilterValue>>;
  /** 候補の上限。打ち切りを判定するため、SQL では 1 件多く取る */
  limit: number;
};

/** グリッドが自動で集める候補と同じラベル */
const BLANK_LABEL = "（空白）";

/** 候補値を取得する SQL。結果の 1 列目を toFilterOptions に渡す */
export function buildFilterOptionsQuery(
  input: FilterOptionsQueryInput,
): BuiltQuery {
  const dialect = getDialect(input.dialect);
  const column = input.columns.find((c) => c.name === input.columnKey);
  if (!column) {
    throw new QueryBuildError(
      `列「${input.columnKey}」が見つかりません`,
      input.columnKey,
    );
  }
  const others = Object.fromEntries(
    Object.entries(input.filters ?? {}).filter(
      ([key]) => key !== input.columnKey,
    ),
  );
  const conditions = buildConditions(dialect, input.columns, others, input);
  const limit = new Param(checkLimit(input.limit, "候補") + 1, {
    kind: "integer",
  });
  // DISTINCT では ORDER BY に SELECT の項目しか書けないので、別名で並べる
  const value = optionValueExpr(dialect, column);
  const alias = raw(dialect.quoteIdent("OPTION_VALUE"));

  const lines: Sql[] = [
    dialect.name === "mssql"
      ? sql`SELECT DISTINCT TOP (${limit}) ${value} AS ${alias}`
      : sql`SELECT DISTINCT ${value} AS ${alias}`,
    sql`FROM ${fromTable(dialect, input.table)}`,
  ];
  if (conditions.length > 0) {
    lines.push(sql`WHERE ${join(conditions, "\n  AND ")}`);
  }
  // 空欄を先頭にして、打ち切られても候補に残るようにする。SQL Server の昇順は NULL と空文字が先頭に来る
  lines.push(
    dialect.name === "oracle"
      ? sql`ORDER BY ${alias} NULLS FIRST`
      : sql`ORDER BY ${alias}`,
  );
  if (dialect.name === "oracle") {
    lines.push(sql`FETCH FIRST ${limit} ROWS ONLY`);
  }
  return finish(join(lines, "\n"), dialect);
}

function optionValueExpr(dialect: Dialect, column: ColumnInfo): Sql {
  const ref = raw(dialect.quoteIdent(column.name));
  switch (column.type.kind) {
    case "string":
    case "number":
      return ref;
    case "datetime":
      // 時刻を持ちうる列も日単位の候補にする。Date で受けると、ドライバのタイムゾーン変換で日がずれることがあるので、文字列にして受ける
      return dialect.ymdFromDate(ref);
    case "other":
      throw new QueryBuildError(
        `「${column.name}」（${column.type.dbTypeName}）は値の選択で絞り込めません`,
        column.name,
      );
  }
}

/**
 * 候補の SQL の結果（1 列目の値）を、グリッドに返す候補にする。
 * 値は WHERE の生成（where.ts の setValue）が受け取る形にそろえる
 */
export function toFilterOptions(
  column: ColumnInfo,
  values: readonly unknown[],
  limit: number,
): FilterOptionsResult {
  const seen = new Set<string>();
  const options: FilterOption[] = [];
  for (const raw of values.slice(0, limit)) {
    const value = optionValue(column, raw);
    // NULL と空文字（SQL Server）は、どちらも空欄の 1 件にまとめる
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ label: value === "" ? BLANK_LABEL : value, value });
  }
  return { options, truncated: values.length > limit };
}

function optionValue(column: ColumnInfo, value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const { type, semantic } = column;
  if (
    type.kind === "datetime" ||
    (type.kind === "string" && semantic?.kind === "date")
  ) {
    // 日付はグリッドに 'YYYY-MM-DD' で渡す。日付でない値（'00000000' など）はそのまま
    return ymdToDateKey(text) ?? text;
  }
  return text;
}
