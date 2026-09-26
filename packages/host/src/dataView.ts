// データビュー（1 テーブル分の画面）のホスト側の制御。VS Code に依存しないので、ブラウザの開発用ページでも動かせる。
// 取得した行の絞り込みと並べ替えは画面（グリッド）がすぐに行う。DB で絞り込むのは、上限で打ち切ったときに
// 利用者が「今の絞り込みで取り直す」を選んだときだけ（D-25）

import {
  buildSelect,
  type ColumnFilterValue,
  QueryBuildError,
  type QuerySource,
  type SortEntry,
  type TableRef,
} from "@sql-editor-tool/core";
import type {
  FromWebview,
  SqlPreview,
  ToWebview,
  ViewColumn,
  ViewInit,
} from "./protocol";
import { errorMessage, QueryRunner } from "./queryRunner";
import type { CellValue, DbSession, QueryRequest } from "./session";

export type DataViewSettings = {
  /** 取得の上限（D-11） */
  maxRows: number;
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
  private readonly runner = new QueryRunner((message) => this.post(message));
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
        return this.execute(message.mode);
      case "cancel":
        this.runner.cancel();
        return;
      case "copySql":
        return this.copySql(message.variant);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.runner.cancel();
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

  /** 主キーの順。上限で打ち切ったときに、どの行を取るかを安定させるため */
  private keySort(): SortEntry[] {
    return this.columns
      .filter((column) => column.isKey)
      .map((column) => ({ columnKey: column.name, direction: "asc" }));
  }

  /** 並べ替えの指定がなければ、主キーの順にする */
  private effectiveSort(): SortEntry[] {
    return this.sort.length > 0 ? this.sort : this.keySort();
  }

  /** 上限 + 1 件を取り、はみ出したかで上限に達したと判定する */
  private buildRowsQuery(
    filters: Record<string, ColumnFilterValue>,
    sort: SortEntry[],
  ): Built {
    return buildSelect({
      dialect: this.deps.session.dialect,
      source: this.source,
      columns: this.columns,
      filters,
      sort,
      limit: this.deps.settings.maxRows + 1,
    });
  }

  /** 画面の絞り込みと並べ替えを WHERE と ORDER BY にした SQL（コピーして A5 などで使える） */
  private preview(): SqlPreview {
    try {
      const built = this.buildRowsQuery(this.filters, this.effectiveSort());
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

  private async execute(mode: "all" | "filtered"): Promise<void> {
    const filters = mode === "filtered" ? this.filters : {};
    const sort = mode === "filtered" ? this.effectiveSort() : this.keySort();
    const { maxRows } = this.deps.settings;
    await this.runner.run({
      session: this.deps.session,
      maxRows,
      filters,
      build: () => this.buildRowsQuery(filters, sort),
      intent: { kind: "rows", source: this.source, sort, limit: maxRows + 1 },
      onColumns: (columns) =>
        columnReorder(
          columns.map((column) => column.name),
          this.columns,
        ),
    });
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
