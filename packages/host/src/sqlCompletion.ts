// SQL の入力補完（D-39）の候補を組み立てる。VS Code に依存しない（拡張は候補を CompletionItem にするだけ）。
// テーブルの一覧と列は接続ごとに覚えておき、補完のたびには DB に問い合わせない

import {
  columnTypeLabel,
  completionContext,
  completionIdentifier,
  type DialectName,
  getDialect,
  sqlKeywords,
  type TableRef,
  type TableReference,
  tableReferences,
} from "@sql-editor-tool/core";
import type { DbSession, SchemaObject, TableDescription } from "./session";

export type CompletionEntry = {
  label: string;
  kind: "column" | "key" | "table" | "view" | "schema" | "keyword";
  /** 候補の横に出す説明（型、スキーマなど） */
  detail: string;
  insertText: string;
  /** 並びの順（列はテーブルの列の順） */
  sortText: string;
  /** 論理名とコメント（D-40）。名前のすぐ横に出し、論理名でも絞り込めるようにする */
  logicalName?: string;
  comment?: string;
  /** 打った文字と比べる文字列。省略時は label */
  filterText?: string;
};

/** 接続ごとのテーブルの一覧と列。「最新の情報に更新」や切断で clear する */
export class SchemaCache {
  private objectsPromise: Promise<SchemaObject[]> | null = null;
  private readonly tables = new Map<string, Promise<TableDescription>>();

  /** session は、まだ接続していなければ接続する */
  constructor(private readonly session: () => Promise<DbSession>) {}

  objects(): Promise<SchemaObject[]> {
    if (!this.objectsPromise) {
      const promise = this.session().then((s) => s.listAllObjects());
      this.objectsPromise = promise;
      // 失敗したら覚えず、次に試し直す
      promise.catch(() => {
        if (this.objectsPromise === promise) this.objectsPromise = null;
      });
    }
    return this.objectsPromise;
  }

  describe(table: TableRef): Promise<TableDescription> {
    const key = JSON.stringify([table.schema, table.name]);
    let promise = this.tables.get(key);
    if (!promise) {
      promise = this.session().then((s) => s.describeTable(table));
      this.tables.set(key, promise);
      const saved = promise;
      saved.catch(() => {
        if (this.tables.get(key) === saved) this.tables.delete(key);
      });
    }
    return promise;
  }

  clear(): void {
    this.objectsPromise = null;
    this.tables.clear();
  }
}

export type CompleteInput = {
  dialect: DialectName;
  text: string;
  offset: number;
  /** 接続がない（選んでいない）ときは null。キーワードだけを出す */
  cache: SchemaCache | null;
};

/** 名前を比べる（大文字小文字を区別しない。SQL Server の照合順序と、Oracle の引用符なしの名前に合わせる） */
export const same = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toUpperCase() === b.toUpperCase();

/** 論理名の比べ方（全角半角・大文字小文字を区別しない。テーブル検索と同じ） */
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

export async function completeSql(
  input: CompleteInput,
): Promise<CompletionEntry[]> {
  const dialect = getDialect(input.dialect);
  const context = completionContext(dialect, input.text, input.offset);
  const { cache } = input;
  switch (context.kind) {
    case "none":
      return [];
    case "general": {
      const words = keywords(input.dialect);
      if (!cache || !context.prefix) return words;
      // 論理名を打ったら、その文のテーブルの列を出す（D-40。ドットのない列名の補完はしない D-39 は、物理名のまま）
      const refs = tableReferences(dialect, input.text, input.offset);
      return [
        ...(await logicalColumnEntries(
          input.dialect,
          cache,
          refs,
          context.prefix,
        )),
        ...words,
      ];
    }
    case "table": {
      if (!cache) return [];
      const objects = await cache.objects();
      return [
        ...tableEntries(input.dialect, objects, null),
        ...schemaEntries(input.dialect, objects),
      ];
    }
    case "member": {
      if (!cache) return [];
      const { path } = context;
      const objects = await cache.objects();
      // FROM の後の「スキーマ.」
      if (context.afterFrom) {
        return tableEntries(input.dialect, objects, path.at(-1) ?? null);
      }
      if (path.length >= 2) {
        const table = findTable(
          objects,
          path.at(-2) ?? null,
          path.at(-1) ?? "",
        );
        return table ? columnEntries(input.dialect, cache, table) : [];
      }
      const name = path[0] ?? "";
      const refs = tableReferences(dialect, input.text, input.offset);
      // 別名 → 別名のないテーブル名 → テーブル名
      const ref =
        refs.find((r) => same(r.alias, name)) ??
        refs.find((r) => r.alias === null && same(r.name, name)) ??
        refs.find((r) => same(r.name, name));
      if (ref) {
        if (ref.name === null || ref.cte) return [];
        const table = findTable(objects, ref.schema, ref.name);
        return table ? columnEntries(input.dialect, cache, table) : [];
      }
      // FROM に書く前でも、テーブル名. なら列を出す
      const table = findTable(objects, null, name);
      if (table) return columnEntries(input.dialect, cache, table);
      // スキーマ名. ならテーブル
      if (objects.some((o) => same(o.schema, name))) {
        return tableEntries(input.dialect, objects, name);
      }
      return [];
    }
  }
}

/** テーブル・ビューを探す。スキーマを書いていなければ、名前の合うもの（大文字小文字も合うものを優先） */
export function findTable(
  objects: readonly SchemaObject[],
  schema: string | null,
  name: string,
): SchemaObject | undefined {
  const found = objects.filter(
    (o) => same(o.name, name) && (schema === null || same(o.schema, schema)),
  );
  return found.find((o) => o.name === name) ?? found[0];
}

async function columnEntries(
  dialectName: DialectName,
  cache: SchemaCache,
  table: SchemaObject,
): Promise<CompletionEntry[]> {
  const dialect = getDialect(dialectName);
  const described = await cache.describe(table);
  const keys = new Set(described.primaryKey);
  return described.columns.map((column, i) => {
    const key = keys.has(column.name);
    return {
      label: column.name,
      kind: key ? "key" : "column",
      detail: `${columnTypeLabel(column.type)}${key ? "・主キー" : ""}（${table.name}）`,
      insertText: completionIdentifier(dialect, column.name),
      sortText: `0${String(i).padStart(4, "0")}`,
      ...logical(column),
    };
  });
}

/**
 * 論理名が prefix で始まる列（文の FROM・JOIN のテーブルのもの）。
 * テーブルが 2 つ以上あれば「別名.列」で入れる（どのテーブルの列か分かるように）
 */
async function logicalColumnEntries(
  dialectName: DialectName,
  cache: SchemaCache,
  refs: readonly TableReference[],
  prefix: string,
): Promise<CompletionEntry[]> {
  const dialect = getDialect(dialectName);
  const wanted = normalize(prefix);
  const objects = await cache.objects();
  const tables = refs.flatMap((ref) => {
    if (ref.name === null || ref.cte) return [];
    const table = findTable(objects, ref.schema, ref.name);
    return table ? [{ ref, table }] : [];
  });
  const described = await Promise.all(
    tables.map(({ table }) => cache.describe(table).catch(() => null)),
  );
  const entries: CompletionEntry[] = [];
  for (const [t, { ref, table }] of tables.entries()) {
    const description = described[t];
    if (!description) continue;
    const keys = new Set(description.primaryKey);
    const qualifier =
      tables.length > 1
        ? `${completionIdentifier(dialect, ref.alias ?? ref.name ?? table.name)}.`
        : "";
    for (const [i, column] of description.columns.entries()) {
      const { logicalName } = column;
      if (!logicalName || !normalize(logicalName).startsWith(wanted)) continue;
      const key = keys.has(column.name);
      entries.push({
        label: `${qualifier}${column.name}`,
        kind: key ? "key" : "column",
        detail: `${columnTypeLabel(column.type)}${key ? "・主キー" : ""}（${table.name}）`,
        insertText: `${qualifier}${completionIdentifier(dialect, column.name)}`,
        sortText: `0${String(t).padStart(2, "0")}${String(i).padStart(4, "0")}`,
        ...logical(column),
        // 打った論理名で絞り込む
        filterText: logicalName,
      });
    }
  }
  return entries;
}

/** 論理名とコメント。論理名でも絞り込めるよう、filterText に名前と論理名を並べる */
function logical(item: {
  name: string;
  logicalName?: string;
  comment?: string;
}): Pick<CompletionEntry, "logicalName" | "comment" | "filterText"> {
  const { name, logicalName, comment } = item;
  return {
    ...(logicalName
      ? { logicalName, filterText: `${name} ${logicalName}` }
      : {}),
    ...(comment ? { comment } : {}),
  };
}

/**
 * テーブル・ビューの候補。schema を指定しなければすべてのスキーマのもの。
 * 同じ名前が複数のスキーマにあれば「スキーマ.名前」で入れる
 */
function tableEntries(
  dialectName: DialectName,
  objects: readonly SchemaObject[],
  schema: string | null,
): CompletionEntry[] {
  const dialect = getDialect(dialectName);
  const ident = (name: string) => completionIdentifier(dialect, name);
  const count = new Map<string, number>();
  for (const o of objects) {
    const key = o.name.toUpperCase();
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return objects
    .filter((o) => schema === null || same(o.schema, schema))
    .map((o) => ({
      label: o.name,
      kind: o.kind,
      detail: `${o.kind === "view" ? "ビュー" : "テーブル"}（${o.schema}）`,
      insertText:
        schema === null && (count.get(o.name.toUpperCase()) ?? 0) > 1
          ? `${ident(o.schema)}.${ident(o.name)}`
          : ident(o.name),
      sortText: `1${o.name}`,
      ...logical(o),
    }));
}

function schemaEntries(
  dialectName: DialectName,
  objects: readonly SchemaObject[],
): CompletionEntry[] {
  const dialect = getDialect(dialectName);
  return [...new Set(objects.map((o) => o.schema))].map((schema) => ({
    label: schema,
    kind: "schema",
    detail: "スキーマ",
    insertText: completionIdentifier(dialect, schema),
    sortText: `2${schema}`,
  }));
}

function keywords(dialectName: DialectName): CompletionEntry[] {
  return sqlKeywords(getDialect(dialectName)).map((word, i) => ({
    label: word,
    kind: "keyword",
    detail: "キーワード",
    insertText: word,
    sortText: `9${String(i).padStart(3, "0")}`,
  }));
}
