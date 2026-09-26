// 段階1（単一テーブル／ビュー）の SELECT 文を組み立てる

import { fromBaseSql, optionsStatement, reportStatement } from "./baseSql";
import { type Dialect, type DialectName, getDialect } from "./dialect";
import { QueryBuildError } from "./errors";
import type { ColumnFilterValue, SortEntry } from "./filter";
import { type ReportConfig, type ReportValues, reportResolver } from "./report";
import type { ColumnInfo, QuerySource } from "./schema";
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
  source: QuerySource;
  columns: readonly ColumnInfo[];
  filters?: Readonly<Record<string, ColumnFilterValue>>;
  sort?: readonly SortEntry[];
  /** 取得する最大行数。上限に達したかを判定するなら「上限 + 1」を渡す */
  limit?: number;
};

// finish / fromSource / checkLimit は候補値の SQL（filterOptions.ts）でも使う

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

  const source = fromSource(dialect, input.source);
  const list = selectList(dialect, input.columns);
  const lines: Sql[] = [
    ...source.withClause,
    dialect.name === "mssql" && limit
      ? sql`SELECT TOP (${limit})${list}`
      : sql`SELECT${list}`,
    sql`FROM ${source.from}`,
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

/**
 * 取得する列（SELECT との間の空白や改行を含む）。文字列に変換して取る列（asText）がなければ * にする。
 * あれば 1 行に 1 列ずつ並べ、その列だけ変換して元の列名を付ける（結果の列名と並びは * と同じ）
 */
function selectList(dialect: Dialect, columns: readonly ColumnInfo[]): Sql {
  if (!columns.some(isAsText)) return raw(" *");
  const items = columns.map((column) => {
    const ref = raw(dialect.quoteIdent(column.name));
    return isAsText(column) ? sql`${dialect.numberAsText(ref)} AS ${ref}` : ref;
  });
  return sql`\n  ${join(items, ",\n  ")}`;
}

export function isAsText(column: ColumnInfo): boolean {
  return column.type.kind === "number" && column.type.asText === true;
}

/** FROM に書く対象と、その前に置く WITH 句（SQL Server のベースSQL のみ。なければ空） */
export function fromSource(
  dialect: Dialect,
  source: QuerySource,
): { withClause: Sql[]; from: Sql } {
  if (source.kind === "baseSql" || source.kind === "report") {
    // レポートは :名前 をフォームの値に置き換え、ORDER BY を取り除いて包む（並べ替えは画面の指定を使う）
    const base = fromBaseSql(
      dialect,
      source.sql,
      source.kind === "report"
        ? {
            resolve: reportResolver(dialect, source.config, source.values),
          }
        : {},
    );
    return {
      withClause: base.withClause ? [base.withClause] : [],
      from: base.from,
    };
  }
  const q = (name: string) => dialect.quoteIdent(name);
  const { schema, name } = source.table;
  return { withClause: [], from: raw(`${q(schema)}.${q(name)}`) };
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

export type ReportQueryInput = {
  dialect: DialectName;
  /** レポートの SQL（.sql ファイルの全文。先頭の設定のコメントはそのままでよい） */
  sql: string;
  config: ReportConfig;
  values: ReportValues;
};

/**
 * レポートの SQL を、フォームの値をバインド変数にして、包まずにそのまま実行する形にする（ORDER BY も効く）。
 * 件数の上限は SQL に付けず、取得する側が上限 + 1 行で打ち切る
 */
export function buildReportQuery(input: ReportQueryInput): BuiltQuery {
  const dialect = getDialect(input.dialect);
  const resolve = reportResolver(dialect, input.config, input.values);
  return finish(reportStatement(dialect, input.sql, resolve), dialect);
}

/**
 * 選択肢の候補を取る SQL（D-34）。1 列目＝値、2 列目＝表示名。
 * 件数の上限は SQL に付けず、取得する側が上限 + 1 行で打ち切る
 */
export function buildOptionsQuery(
  dialectName: DialectName,
  text: string,
): BuiltQuery {
  const dialect = getDialect(dialectName);
  return finish(optionsStatement(dialect, text), dialect);
}
