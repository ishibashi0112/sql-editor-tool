// 段階1（単一テーブル／ビュー）の SELECT 文を組み立てる

import { type Dialect, type DialectName, getDialect } from "./dialect";
import { QueryBuildError } from "./errors";
import type { ColumnFilterValue, SortEntry } from "./filter";
import type { ColumnInfo, TableRef } from "./schema";
import {
  type BoundParam,
  join,
  Param,
  raw,
  renderBind,
  renderLiteral,
  type Sql,
  sql,
} from "./sql";
import { buildConditions, type ConditionOptions } from "./where";

export type BuiltQuery = {
  /** バインド変数つきの SQL（実行用） */
  sql: string;
  params: BoundParam[];
  /** 値をリテラルに展開した SQL（表示とコピー用。実行には使わない） */
  literalSql: string;
};

export type WhereInput = ConditionOptions & {
  dialect: DialectName;
  columns: readonly ColumnInfo[];
  filters: Readonly<Record<string, ColumnFilterValue>>;
};

export type SelectInput = ConditionOptions & {
  dialect: DialectName;
  table: TableRef;
  columns: readonly ColumnInfo[];
  filters?: Readonly<Record<string, ColumnFilterValue>>;
  sort?: readonly SortEntry[];
  /** 取得する最大行数。上限に達したかを判定するなら「上限 + 1」を渡す */
  limit?: number;
};

// finish / fromTable / checkLimit は候補値の SQL（filterOptions.ts）でも使う

export function finish(fragment: Sql, dialect: Dialect): BuiltQuery {
  return {
    ...renderBind(fragment, dialect),
    literalSql: renderLiteral(fragment, dialect),
  };
}

/** WHERE 句の条件だけ（WHERE は付けない）。条件がなければ null */
export function buildWhere(input: WhereInput): BuiltQuery | null {
  const dialect = getDialect(input.dialect);
  const conditions = buildConditions(
    dialect,
    input.columns,
    input.filters,
    input,
  );
  return conditions.length > 0
    ? finish(join(conditions, "\n  AND "), dialect)
    : null;
}

export function buildSelect(input: SelectInput): BuiltQuery {
  const dialect = getDialect(input.dialect);
  const q = (name: string) => dialect.quoteIdent(name);
  const conditions = buildConditions(
    dialect,
    input.columns,
    input.filters ?? {},
    input,
  );
  const limit = input.limit === undefined ? null : limitParam(input.limit);

  const lines: Sql[] = [
    dialect.name === "mssql" && limit
      ? sql`SELECT TOP (${limit}) *`
      : sql`SELECT *`,
    sql`FROM ${fromTable(dialect, input.table)}`,
  ];
  if (conditions.length > 0) {
    lines.push(sql`WHERE ${join(conditions, "\n  AND ")}`);
  }
  const orderBy = (input.sort ?? []).map((entry) => {
    if (!input.columns.some((column) => column.name === entry.columnKey)) {
      throw new QueryBuildError(
        `並べ替えの列「${entry.columnKey}」が見つかりません`,
        entry.columnKey,
      );
    }
    return raw(
      `${q(entry.columnKey)} ${entry.direction === "desc" ? "DESC" : "ASC"}`,
    );
  });
  if (orderBy.length > 0) lines.push(sql`ORDER BY ${join(orderBy, ", ")}`);
  if (dialect.name === "oracle" && limit) {
    lines.push(sql`FETCH FIRST ${limit} ROWS ONLY`);
  }
  return finish(join(lines, "\n"), dialect);
}

export function fromTable(dialect: Dialect, table: TableRef): Sql {
  const q = (name: string) => dialect.quoteIdent(name);
  return raw(`${q(table.schema)}.${q(table.name)}`);
}

export function checkLimit(limit: number, what: string): number {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new QueryBuildError(
      `${what}の上限は 1 以上の整数にしてください（${limit}）`,
    );
  }
  return limit;
}

function limitParam(limit: number): Param {
  return new Param(checkLimit(limit, "取得件数"), { kind: "integer" });
}
