// デモ接続。DB なしで画面の動きを確かめるためのもの（Mac では社内 DB に繋げないため）。
// SQL は解釈しない。QueryRequest の intent から結果を作るので、WHERE の条件では絞り込まない

import type { DialectName, SortEntry, TableRef } from "@sql-editor-tool/core";
import {
  abortError,
  type CellValue,
  type DbObject,
  type DbSession,
  type QueryHandlers,
  type QueryRequest,
  type SchemaObject,
  type TableDescription,
} from "../session";
import { DEMO_TABLES, type DemoTable } from "./demoData";

const CHUNK_SIZE = 2000;

export type DemoSessionOptions = {
  dialect: DialectName;
  /** 1 チャンクごとの待ち時間（ミリ秒）。取得中の表示やキャンセルを確かめるため */
  chunkDelayMs?: number;
};

export class DemoSession implements DbSession {
  readonly dialect: DialectName;
  private readonly chunkDelayMs: number;

  constructor(options: DemoSessionOptions) {
    this.dialect = options.dialect;
    this.chunkDelayMs = options.chunkDelayMs ?? 30;
  }

  async listSchemas(): Promise<string[]> {
    return [...new Set(DEMO_TABLES.map((t) => t.schema))];
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    return DEMO_TABLES.filter((t) => t.schema === schema).map(
      ({ name, kind }) => ({
        name,
        kind,
      }),
    );
  }

  async listAllObjects(): Promise<SchemaObject[]> {
    return DEMO_TABLES.map(({ schema, name, kind }) => ({
      schema,
      name,
      kind,
    }));
  }

  async describeTable(table: TableRef): Promise<TableDescription> {
    const found = findTable(table);
    return { columns: found.columns, primaryKey: found.primaryKey };
  }

  async query(request: QueryRequest, handlers: QueryHandlers): Promise<void> {
    const { intent } = request;
    if (intent.source.kind !== "table") {
      throw new Error("デモ接続ではベースSQL を実行できません");
    }
    const table = findTable(intent.source.table);
    handlers.onColumns(table.columns.map((c) => c.name));
    const rows = sortRows(table, intent.sort).slice(0, intent.limit);
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      await this.wait(handlers.signal);
      handlers.onRows(rows.slice(i, i + CHUNK_SIZE));
    }
  }

  async close(): Promise<void> {}

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.chunkDelayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function findTable(table: TableRef): DemoTable {
  const found = DEMO_TABLES.find(
    (t) => t.schema === table.schema && t.name === table.name,
  );
  if (!found)
    throw new Error(`テーブル「${table.schema}.${table.name}」がありません`);
  return found;
}

function sortRows(table: DemoTable, sort: readonly SortEntry[]): CellValue[][] {
  const rows = table.rows();
  const keys = sort.map((entry) => ({
    index: table.columns.findIndex((c) => c.name === entry.columnKey),
    sign: entry.direction === "desc" ? -1 : 1,
  }));
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { index, sign } of keys) {
      const order = compareBlankFirst(a[index] ?? null, b[index] ?? null);
      if (order !== 0) return order * sign;
    }
    return 0;
  });
}

/** NULL と空文字を先頭にする（SQL Server の昇順と同じ） */
function compareBlankFirst(a: CellValue, b: CellValue): number {
  const blankA = a === null || a === "";
  const blankB = b === null || b === "";
  if (blankA || blankB) return Number(blankB) - Number(blankA);
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
