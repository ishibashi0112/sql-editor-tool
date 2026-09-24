// データビュー（1 テーブル分の画面）のホスト側の制御。VS Code に依存しないので、ブラウザの開発用ページでも動かせる

import {
  buildFilterOptionsQuery,
  buildSelect,
  type ColumnFilterValue,
  QueryBuildError,
  type QuerySource,
  type SortEntry,
  type TableRef,
  toFilterOptions,
} from "@sql-editor-tool/core";
import type {
  FromWebview,
  SqlPreview,
  ToWebview,
  ViewColumn,
  ViewInit,
} from "./protocol";
import {
  type CellValue,
  type DbSession,
  isAbortError,
  type QueryRequest,
} from "./session";

export type DataViewSettings = {
  /** 取得の上限（D-11） */
  maxRows: number;
  /** 集合フィルタの候補の上限（D-16） */
  filterOptionsLimit: number;
};

export type DataViewDeps = {
  session: DbSession;
  table: TableRef;
  settings: DataViewSettings;
  demo: boolean;
  post(message: ToWebview): void;
  copyText(text: string): Promise<void>;
};

type Built = {
  sql: string;
  params: QueryRequest["params"];
  literalSql: string;
};

export class DataViewController {
  private columns: ViewColumn[] = [];
  private filters: Record<string, ColumnFilterValue> = {};
  private sort: SortEntry[] = [];
  private queryId = 0;
  private running: AbortController | null = null;
  private readonly optionRequests = new Map<number, AbortController>();
  private disposed = false;

  constructor(private readonly deps: DataViewDeps) {}

  private get source(): QuerySource {
    return { kind: "table", table: this.deps.table };
  }

  async handle(message: FromWebview): Promise<void> {
    switch (message.type) {
      case "ready":
        return this.init();
      case "conditionsChanged":
        this.filters = message.filters;
        this.sort = message.sort;
        this.postPreview();
        return;
      case "execute":
        return this.execute();
      case "cancel":
        this.running?.abort();
        return;
      case "getFilterOptions":
        return this.filterOptions(
          message.requestId,
          message.columnKey,
          message.columnFilters,
        );
      case "abortFilterOptions":
        this.optionRequests.get(message.requestId)?.abort();
        return;
      case "copySql":
        return this.copySql(message.variant);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.running?.abort();
    for (const request of this.optionRequests.values()) request.abort();
  }

  private post(message: ToWebview): void {
    if (!this.disposed) this.deps.post(message);
  }

  private async init(): Promise<void> {
    const { table, session, settings, demo } = this.deps;
    try {
      const described = await session.describeTable(table);
      const keys = new Set(described.primaryKey);
      this.columns = described.columns.map((column) => ({
        ...column,
        isKey: keys.has(column.name),
      }));
    } catch (error) {
      this.post({ type: "initFailed", message: errorMessage(error) });
      return;
    }
    const view: ViewInit = {
      title: `${table.schema}.${table.name}`,
      dialect: session.dialect,
      columns: this.columns,
      maxRows: settings.maxRows,
      demo,
    };
    this.post({ type: "init", view });
    this.postPreview();
  }

  /** 並べ替えの指定がなければ、主キーの順にする（行の並びを安定させるため） */
  private effectiveSort(): SortEntry[] {
    if (this.sort.length > 0) return this.sort;
    return this.columns
      .filter((column) => column.isKey)
      .map((column) => ({ columnKey: column.name, direction: "asc" }));
  }

  /** 上限 + 1 件を取り、はみ出したかで上限に達したと判定する */
  private buildRowsQuery(): Built {
    return buildSelect({
      dialect: this.deps.session.dialect,
      source: this.source,
      columns: this.columns,
      filters: this.filters,
      sort: this.effectiveSort(),
      limit: this.deps.settings.maxRows + 1,
    });
  }

  private preview(): SqlPreview {
    try {
      const built = this.buildRowsQuery();
      return { ok: true, sql: built.sql, literalSql: built.literalSql };
    } catch (error) {
      if (error instanceof QueryBuildError) {
        return {
          ok: false,
          message: error.message,
          columnKey: error.columnKey,
        };
      }
      throw error;
    }
  }

  private postPreview(): void {
    this.post({ type: "preview", preview: this.preview() });
  }

  private async execute(): Promise<void> {
    this.running?.abort();
    const queryId = ++this.queryId;
    const abort = new AbortController();
    this.running = abort;
    const { maxRows } = this.deps.settings;
    const started = Date.now();
    let rowCount = 0;
    let truncated = false;
    // ドライバのイベントの中で投げた例外は失われることがあるので、覚えておいて中断する
    let failure: unknown = null;

    this.post({ type: "queryStarted", queryId });
    try {
      const built = this.buildRowsQuery();
      let reorder: ((row: CellValue[]) => CellValue[]) | null = null;
      await this.deps.session.query(
        {
          sql: built.sql,
          params: built.params,
          intent: {
            kind: "rows",
            source: this.source,
            sort: this.effectiveSort(),
            limit: maxRows + 1,
          },
        },
        {
          signal: abort.signal,
          onColumns: (names) => {
            try {
              reorder = columnReorder(names, this.columns);
            } catch (error) {
              failure = error;
              abort.abort();
            }
          },
          onRows: (rows) => {
            if (truncated || failure) return;
            let chunk = reorder ? rows.map(reorder) : rows;
            if (rowCount + chunk.length > maxRows) {
              truncated = true;
              chunk = chunk.slice(0, maxRows - rowCount);
            }
            rowCount += chunk.length;
            if (chunk.length > 0)
              this.post({ type: "rows", queryId, rows: chunk });
            // 上限を超えたら、残りは取らない
            if (truncated) abort.abort();
          },
        },
      );
    } catch (error) {
      const cause = failure ?? error;
      if (!(truncated && isAbortError(cause))) {
        this.post({
          type: "queryFailed",
          queryId,
          message: errorMessage(cause),
          cancelled: isAbortError(cause),
        });
        return;
      }
    } finally {
      if (this.running === abort) this.running = null;
    }
    this.post({
      type: "queryDone",
      queryId,
      rowCount,
      truncated,
      elapsedMs: Date.now() - started,
    });
  }

  private async filterOptions(
    requestId: number,
    columnKey: string,
    columnFilters: Record<string, ColumnFilterValue>,
  ): Promise<void> {
    const abort = new AbortController();
    this.optionRequests.set(requestId, abort);
    const limit = this.deps.settings.filterOptionsLimit;
    try {
      const column = this.columns.find((c) => c.name === columnKey);
      if (!column)
        throw new QueryBuildError(`列「${columnKey}」が見つかりません`);
      const built = buildFilterOptionsQuery({
        dialect: this.deps.session.dialect,
        source: this.source,
        columns: this.columns,
        columnKey,
        filters: columnFilters,
        limit,
      });
      const values: unknown[] = [];
      await this.deps.session.query(
        {
          sql: built.sql,
          params: built.params,
          intent: {
            kind: "filterOptions",
            source: this.source,
            columnKey,
            limit: limit + 1,
          },
        },
        {
          signal: abort.signal,
          onColumns: () => {},
          onRows: (rows) => {
            for (const row of rows) values.push(row[0]);
          },
        },
      );
      this.post({
        type: "filterOptions",
        requestId,
        result: toFilterOptions(column, values, limit),
      });
    } catch (error) {
      // 中断はグリッドが popover を閉じたときなので、結果を返さない
      if (!isAbortError(error)) {
        this.post({
          type: "filterOptionsFailed",
          requestId,
          message: errorMessage(error),
        });
      }
    } finally {
      this.optionRequests.delete(requestId);
    }
  }

  private async copySql(variant: "bind" | "literal"): Promise<void> {
    const preview = this.preview();
    if (!preview.ok) return;
    await this.deps.copyText(
      variant === "bind" ? preview.sql : preview.literalSql,
    );
  }
}

/** 結果の列の並びが画面の列と違うときだけ並べ替える関数を返す */
function columnReorder(
  names: readonly string[],
  columns: readonly ViewColumn[],
): ((row: CellValue[]) => CellValue[]) | null {
  if (
    names.length === columns.length &&
    names.every((name, i) => name === columns[i]?.name)
  ) {
    return null;
  }
  const indexes = columns.map((column) => names.indexOf(column.name));
  const missing = columns.filter((_, i) => indexes[i] === -1);
  if (missing.length > 0) {
    throw new Error(
      `結果に列「${missing.map((c) => c.name).join("、")}」がありません。テーブルの定義が変わった可能性があるので、開き直してください`,
    );
  }
  return (row) => indexes.map((i) => row[i] ?? null);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
