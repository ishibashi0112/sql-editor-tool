// SQL に書いたテーブル名・列名が、DB のどのテーブル・列かを決める（D-40）。
// .sql のホバーと、論理名のインレイヒントに使う。VS Code に依存しない。
// 名前の読み方は core の sqlOutline（書きかけの SQL でも例外にしない）。列は文の FROM・JOIN のテーブルから探す

import {
  type ColumnInfo,
  type DialectName,
  getDialect,
  type LogicalName,
  type NameReference,
  type SqlOutline,
  sqlComments,
  sqlOutline,
  type TableReference,
} from "@sql-editor-tool/core";
import type { SchemaObject, TableDescription } from "./session";
import { findTable, type SchemaCache, same } from "./sqlCompletion";

export type SqlSymbol =
  | {
      kind: "table";
      /** 名前（引用符も含む）の位置 */
      start: number;
      end: number;
      object: SchemaObject;
      /** 名前の直後に書いた別名（論理名と同じならヒントは出さない） */
      alias: string | null;
    }
  | {
      kind: "column";
      start: number;
      end: number;
      table: SchemaObject;
      column: ColumnInfo;
      isKey: boolean;
      alias: string | null;
    };

export type ResolveInput = {
  dialect: DialectName;
  text: string;
  cache: SchemaCache;
  /** この範囲に掛かる名前だけを決める（省略時は全体）。インレイヒントは見えている範囲だけ */
  from?: number;
  to?: number;
};

/** 範囲の中の名前のうち、テーブル・列が分かったもの（出てくる順） */
export async function resolveSymbols(
  input: ResolveInput,
): Promise<SqlSymbol[]> {
  const outline = sqlOutline(getDialect(input.dialect), input.text);
  const from = input.from ?? 0;
  const to = input.to ?? input.text.length;
  const names = outline.names.filter((n) => {
    const last = n.parts.at(-1);
    return last !== undefined && last.end >= from && last.start <= to;
  });
  if (names.length === 0) return [];
  const objects = await input.cache.objects();
  const tables = new StatementTables(outline, objects, input.cache);
  const symbols: SqlSymbol[] = [];
  for (const name of names) {
    const symbol = await resolveName(name, objects, tables);
    if (symbol) symbols.push(symbol);
  }
  return symbols;
}

/**
 * 同じ行の、名前より後ろのコメントに論理名を書いてある名前を除く。A5:SQL Mk-2 や「SQL を生成」（D-49）で作った
 * `ORDER_NO  -- 受注番号` のような行で、行の終わりの論理名の札（D-42）が同じことを二重に出さないように
 */
export function withoutCommentedNames(
  dialect: DialectName,
  text: string,
  symbols: readonly SqlSymbol[],
): SqlSymbol[] {
  if (!text.includes("--") && !text.includes("/*")) return [...symbols];
  const comments = sqlComments(getDialect(dialect), text);
  return symbols.filter((symbol) => {
    const logicalName =
      symbol.kind === "table"
        ? symbol.object.logicalName
        : symbol.column.logicalName;
    if (!logicalName) return true;
    const newline = text.indexOf("\n", symbol.end);
    const lineEnd = newline < 0 ? text.length : newline;
    return !comments.some(
      (c) =>
        c.start >= symbol.end &&
        c.start < lineEnd &&
        text.slice(c.start, c.end).includes(logicalName),
    );
  });
}

/** offset の位置の名前（ホバー用） */
export async function symbolAt(
  input: Omit<ResolveInput, "from" | "to"> & { offset: number },
): Promise<SqlSymbol | null> {
  const symbols = await resolveSymbols({
    ...input,
    from: input.offset,
    to: input.offset,
  });
  return (
    symbols.find((s) => s.start <= input.offset && input.offset <= s.end) ??
    null
  );
}

/**
 * 結果の列の論理名（レポート・.sql の実行の結果の列見出し、D-40）。結果の列がどのテーブルのものかは分からないので、
 * SQL の FROM・JOIN のテーブル（副問い合わせのものも含む）に同じ名前の列が 1 つだけあれば、その論理名にする
 * （いくつもあって論理名が違えば付けない）。別名を付けた列や式の列は、ふつうは見つからないので付かない
 */
export async function describeResultColumns(input: {
  dialect: DialectName;
  text: string;
  cache: SchemaCache;
  names: readonly string[];
}): Promise<LogicalName[]> {
  const outline = sqlOutline(getDialect(input.dialect), input.text);
  const objects = await input.cache.objects();
  const tables = new StatementTables(outline, objects, input.cache);
  const described = (
    await Promise.all(outline.statements.map((_, i) => tables.of(i)))
  ).flat();
  return input.names.map((name) => {
    const found = described.flatMap((t) => {
      const column = findColumn(t.description, name);
      return column ? [column] : [];
    });
    const labels = new Set(found.map((c) => c.logicalName));
    const [first] = found;
    if (!first || labels.size !== 1) return {};
    const note: LogicalName = {};
    if (first.logicalName) note.logicalName = first.logicalName;
    if (first.comment) note.comment = first.comment;
    return note;
  });
}

/** 文ごとの FROM・JOIN のテーブルと、その列（必要になったときに DB から取る。取れなければ除く） */
class StatementTables {
  private readonly resolved = new Map<number, Promise<ResolvedTable[]>>();

  constructor(
    private readonly outline: SqlOutline,
    private readonly objects: readonly SchemaObject[],
    private readonly cache: SchemaCache,
  ) {}

  of(statement: number): Promise<ResolvedTable[]> {
    let promise = this.resolved.get(statement);
    if (!promise) {
      const refs = this.outline.statements[statement]?.tables ?? [];
      promise = Promise.all(refs.map((ref) => this.resolve(ref))).then((list) =>
        list.flatMap((t) => (t ? [t] : [])),
      );
      this.resolved.set(statement, promise);
    }
    return promise;
  }

  refs(statement: number): readonly TableReference[] {
    return this.outline.statements[statement]?.tables ?? [];
  }

  async describe(object: SchemaObject): Promise<TableDescription | null> {
    return this.cache.describe(object).catch(() => null);
  }

  private async resolve(ref: TableReference): Promise<ResolvedTable | null> {
    if (ref.name === null || ref.cte) return null;
    const object = findTable(this.objects, ref.schema, ref.name);
    if (!object) return null;
    const description = await this.describe(object);
    return description ? { ref, object, description } : null;
  }
}

type ResolvedTable = {
  ref: TableReference;
  object: SchemaObject;
  description: TableDescription;
};

async function resolveName(
  name: NameReference,
  objects: readonly SchemaObject[],
  tables: StatementTables,
): Promise<SqlSymbol | null> {
  const { parts, alias } = name;
  const last = parts.at(-1);
  if (!last) return null;
  const at = { start: last.start, end: last.end, alias };
  const tableSymbol = (object: SchemaObject): SqlSymbol => ({
    kind: "table",
    ...at,
    object,
  });
  const columnIn = async (
    object: SchemaObject,
    description?: TableDescription | null,
  ): Promise<SqlSymbol | null> => {
    const described = description ?? (await tables.describe(object));
    const column = described ? findColumn(described, last.name) : undefined;
    if (!described || !column) return null;
    return {
      kind: "column",
      ...at,
      table: object,
      column,
      isKey: described.primaryKey.includes(column.name),
    };
  };

  if (name.table) {
    const schema = parts.length >= 2 ? (parts.at(-2)?.name ?? null) : null;
    const object = findTable(objects, schema, last.name);
    return object ? tableSymbol(object) : null;
  }

  if (parts.length === 1) {
    // 文の FROM・JOIN のテーブルのうち、その名前の列を持つもの
    const found: SqlSymbol[] = [];
    for (const t of await tables.of(name.statement)) {
      const symbol = await columnIn(t.object, t.description);
      if (symbol) found.push(symbol);
    }
    const [first] = found;
    if (!first) return null;
    // 複数のテーブルにある列は、どれか決められない（論理名がすべて同じなら、それを出す）
    const labels = new Set(
      found.map((s) => (s.kind === "column" ? s.column.logicalName : "")),
    );
    return found.length === 1 || (labels.size === 1 && !labels.has(undefined))
      ? first
      : null;
  }

  const qualifier = parts.at(-2)?.name ?? "";
  if (parts.length >= 3) {
    // スキーマ.テーブル.列
    const table = findTable(objects, parts.at(-3)?.name ?? null, qualifier);
    return table ? columnIn(table) : null;
  }
  // 別名 → 別名のないテーブル名 → テーブル名（補完と同じ順）
  const refs = tables.refs(name.statement);
  const ref =
    refs.find((r) => same(r.alias, qualifier)) ??
    refs.find((r) => r.alias === null && same(r.name, qualifier)) ??
    refs.find((r) => same(r.name, qualifier));
  if (ref) {
    if (ref.name === null || ref.cte) return null;
    const object = findTable(objects, ref.schema, ref.name);
    return object ? columnIn(object) : null;
  }
  const table = findTable(objects, null, qualifier);
  if (table) return columnIn(table);
  // スキーマ.テーブル（FROM の外に書いたもの）
  const object = findTable(objects, qualifier, last.name);
  return object ? tableSymbol(object) : null;
}

function findColumn(
  description: TableDescription,
  name: string,
): ColumnInfo | undefined {
  const found = description.columns.filter((c) => same(c.name, name));
  return found.find((c) => c.name === name) ?? found[0];
}
