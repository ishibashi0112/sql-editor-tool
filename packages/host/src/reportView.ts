// レポート（SQL＋フォーム）の画面のホスト側の制御（docs/handover.md §16、D-26〜D-31）。
// VS Code に依存しないので、ブラウザの開発用ページでも動かせる

import {
  buildReportQuery,
  buildSelect,
  type ColumnFilterValue,
  checkBaseColumns,
  getDialect,
  parseReportConfig,
  QueryBuildError,
  type QuerySource,
  type ReportConfig,
  type ReportParam,
  reportParams,
  type SortEntry,
} from "@sql-editor-tool/core";
import type { SqlPreview, ViewColumn } from "./protocol";
import { QueryRunner } from "./queryRunner";
import type {
  FromReport,
  ReportFormValues,
  ReportInit,
  ToReport,
} from "./reportProtocol";
import type { DbSession, ResultColumn } from "./session";

export type ReportConnection = NonNullable<ReportInit["connection"]>;

export type ReportViewDeps = {
  title: string;
  /** .sql ファイルの全文（先頭の設定のコメントを含む） */
  text: string;
  connection: ReportConnection | null;
  /** 接続を開く（まだ開いていなければ開く） */
  openSession(): Promise<DbSession>;
  settings: { maxRows: number };
  /** 入力欄に最初に入れる値（前回の値）。なければ既定値 */
  initialValues?: ReportFormValues | undefined;
  post(message: ToReport): void;
  copyText(text: string): Promise<void>;
  /** 設定を .sql の先頭のコメントに書く。書いた後、拡張が update で新しい全文を渡す */
  saveConfig(config: ReportConfig): Promise<void>;
  editSql(): void;
  chooseConnection(): void;
  /** フォームの値が変わったとき（拡張が覚えておき、次に開いたときに入れる） */
  onValuesChanged?(values: ReportFormValues): void;
};

export class ReportController {
  private text: string;
  private connection: ReportConnection | null;
  private config: ReportConfig = {};
  private configError: string | null = null;
  private params: ReportParam[] = [];
  private values: ReportFormValues = {};
  /** 直前の結果の列（画面の列）と、結果の元の列名 */
  private columns: ViewColumn[] = [];
  private resultNames: string[] = [];
  private filters: Record<string, ColumnFilterValue> = {};
  private sort: SortEntry[] = [];
  private readonly runner = new QueryRunner((message) => this.post(message));
  private disposed = false;

  constructor(private readonly deps: ReportViewDeps) {
    this.text = deps.text;
    this.connection = deps.connection;
    this.parse(deps.initialValues ?? {});
  }

  async handle(message: FromReport): Promise<void> {
    switch (message.type) {
      case "ready":
        this.postInit();
        return;
      case "valuesChanged":
        this.values = message.values;
        this.deps.onValuesChanged?.(this.values);
        this.postPreview();
        return;
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
      case "saveParams":
        return this.deps.saveConfig({
          ...this.config,
          params: message.params,
        });
      case "editSql":
        this.deps.editSql();
        return;
      case "chooseConnection":
        this.deps.chooseConnection();
        return;
    }
  }

  /** ファイルが書き換わった・接続が変わったとき。入力した値は、同じ名前の入力欄に残す */
  update(text: string, connection: ReportConnection | null): void {
    this.text = text;
    this.connection = connection;
    this.parse(this.values);
    this.postInit();
  }

  dispose(): void {
    this.disposed = true;
    this.runner.cancel();
  }

  private post(message: ToReport): void {
    if (!this.disposed) this.deps.post(message);
  }

  private parse(previous: ReportFormValues): void {
    const { config, error } = parseReportConfig(this.text);
    this.config = config;
    this.configError = error;
    // 入力欄の一覧は方言に左右されない（:名前 の読み方は同じ）
    const dialect = this.connection?.dialect ?? "mssql";
    try {
      this.params = reportParams(dialect, this.text, config);
    } catch {
      // SQL の字句の誤り（閉じていない文字列など）は、実行するときにエラーとして出す
      this.params = [];
    }
    this.values = Object.fromEntries(
      this.params.map((p) => [p.name, previous[p.name] ?? p.default]),
    );
  }

  private postInit(): void {
    this.post({
      type: "init",
      view: {
        title: this.deps.title,
        connection: this.connection,
        params: this.params,
        values: this.values,
        maxRows: this.deps.settings.maxRows,
        configError: this.configError,
      },
    });
    this.postPreview();
  }

  private get source(): QuerySource {
    return {
      kind: "report",
      sql: this.text,
      config: this.config,
      values: this.values,
    };
  }

  /** 画面で絞り込み・並べ替えをしているか */
  private get narrowed(): boolean {
    return Object.keys(this.filters).length > 0 || this.sort.length > 0;
  }

  /** フォームの値で、SQL をそのまま実行する形 */
  private buildDirect(connection: ReportConnection) {
    return buildReportQuery({
      dialect: connection.dialect,
      sql: this.text,
      config: this.config,
      values: this.values,
    });
  }

  /** 画面の絞り込みと並べ替えを WHERE と ORDER BY にして、SQL を包んだ形（上限 + 1 件） */
  private buildNarrowed(connection: ReportConnection) {
    // 外側で列を名前で参照するので、名前のない列と重複した列名は使えない
    checkBaseColumns(getDialect(connection.dialect), this.resultNames);
    return buildSelect({
      dialect: connection.dialect,
      source: this.source,
      columns: this.columns,
      filters: this.filters,
      sort: this.sort,
      limit: this.deps.settings.maxRows + 1,
    });
  }

  /** 画面の見た目どおりの SQL（絞り込みがなければ、フォームの値を入れたレポートの SQL そのもの） */
  private preview(): SqlPreview {
    const { connection } = this;
    if (!connection) {
      return { ok: false, message: "実行する接続を選んでください" };
    }
    try {
      const built = this.narrowed
        ? this.buildNarrowed(connection)
        : this.buildDirect(connection);
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
    const { connection } = this;
    if (!connection) {
      this.deps.chooseConnection();
      return;
    }
    let session: DbSession;
    try {
      session = await this.deps.openSession();
    } catch (error) {
      this.post({
        type: "queryFailed",
        queryId: 0,
        message: `接続できませんでした：${error instanceof Error ? error.message : String(error)}`,
        cancelled: false,
      });
      return;
    }
    const filtered = mode === "filtered";
    const { maxRows } = this.deps.settings;
    await this.runner.run({
      session,
      maxRows,
      filters: filtered ? this.filters : {},
      build: () =>
        filtered
          ? this.buildNarrowed(connection)
          : this.buildDirect(connection),
      intent: {
        kind: "rows",
        source: this.source,
        sort: filtered ? this.sort : [],
        limit: maxRows + 1,
      },
      onColumns: (columns, queryId) => {
        this.resultNames = columns.map((column) => column.name);
        this.columns = toViewColumns(columns);
        this.post({ type: "columns", queryId, columns: this.columns });
        return null;
      },
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

/**
 * 結果の列を画面の列にする。グリッドの列キーは重ならないようにする必要があるので、
 * 名前のない列は「（列 3）」、重複した列名は「名前 (2)」にする（その列で取り直すときは checkBaseColumns がエラーにする）
 */
export function toViewColumns(columns: readonly ResultColumn[]): ViewColumn[] {
  const used = new Set<string>();
  return columns.map((column, i) => {
    let name = column.name || `（列 ${i + 1}）`;
    for (let n = 2; used.has(name); n += 1) name = `${column.name} (${n})`;
    used.add(name);
    return { name, type: column.type, isKey: false };
  });
}
