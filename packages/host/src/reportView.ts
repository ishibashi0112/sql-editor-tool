// レポート（SQL＋フォーム）の画面のホスト側の制御（docs/handover.md §16、D-26〜D-35）。
// VS Code に依存しないので、ブラウザの開発用ページでも動かせる

import {
  buildOptionsQuery,
  buildReportQuery,
  buildSelect,
  type ColumnFilterValue,
  checkBaseColumns,
  type GuessedParamTypes,
  getDialect,
  guessReportParamTypes,
  hasRelativeDefault,
  parseReportConfig,
  QueryBuildError,
  type QuerySource,
  type ReportConfig,
  type ReportParam,
  reportDefaultValue,
  reportParamProbe,
  reportParams,
  type SortEntry,
  withGuessedTypes,
} from "@sql-editor-tool/core";
import type { SqlPreview, ViewColumn } from "./protocol";
import { QueryRunner } from "./queryRunner";
import type {
  FromReport,
  ReportFormValues,
  ReportInit,
  ReportOption,
  ReportOptionsState,
  ToReport,
} from "./reportProtocol";
import {
  type CellValue,
  type DbSession,
  isAbortError,
  type ResultColumn,
} from "./session";

/** 選択肢の候補の上限（集合フィルタの候補と同じ 1 万件。D-16） */
export const OPTIONS_LIMIT = 10_000;

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
  /** 今の時刻（相対の日付の既定値を計算する。テストで差し替える） */
  now?(): Date;
};

export class ReportController {
  private text: string;
  private connection: ReportConnection | null;
  private config: ReportConfig = {};
  private configError: string | null = null;
  private params: ReportParam[] = [];
  private values: ReportFormValues = {};
  /** DB が推定した入力欄の種類（D-35）と、推定した SQL（同じ SQL では推定し直さない） */
  private guessed: GuessedParamTypes = {};
  private guessKey: string | null = null;
  /** 選択肢の候補（入力欄の名前 → 候補の SQL と取得の状況） */
  private options = new Map<
    string,
    { key: string; state: ReportOptionsState; abort: AbortController }
  >();
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
    this.parse(deps.initialValues ?? {}, true);
    this.loadFromDb();
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
    // 接続が変わったら、前の接続で推定した種類は使わない
    if (connection?.name !== this.connection?.name) {
      this.guessed = {};
      this.guessKey = null;
    }
    this.text = text;
    this.connection = connection;
    this.parse(this.values, false);
    this.postInit();
    this.loadFromDb();
  }

  dispose(): void {
    this.disposed = true;
    this.runner.cancel();
    for (const { abort } of this.options.values()) abort.abort();
  }

  private post(message: ToReport): void {
    if (!this.disposed) this.deps.post(message);
  }

  /**
   * 設定と入力欄を読み直す。fresh は開いたとき：相対の日付の既定値（今日・月初など）を持つ入力欄は、
   * 前回の値ではなく既定値から計算する（D-33）。開いたままの書き換えでは、入力した値を残す
   */
  private parse(previous: ReportFormValues, fresh: boolean): void {
    const { config, error } = parseReportConfig(this.text);
    this.config = config;
    this.configError = error;
    // 入力欄の一覧は方言に左右されない（:名前 の読み方は同じ）
    const dialect = this.connection?.dialect ?? "mssql";
    try {
      this.params = reportParams(dialect, this.text, config, this.guessed);
    } catch {
      // SQL の字句の誤り（閉じていない文字列など）は、実行するときにエラーとして出す
      this.params = [];
    }
    const now = this.deps.now?.() ?? new Date();
    this.values = Object.fromEntries(
      this.params.map((p) => {
        const value = previous[p.name];
        // 既定値のまま（推定で日付の種類になった直後など）なら、日付に計算し直す
        const recompute =
          hasRelativeDefault(p) &&
          (fresh || value === undefined || value === p.default);
        return [
          p.name,
          recompute
            ? reportDefaultValue(p, now)
            : (value ?? reportDefaultValue(p, now)),
        ];
      }),
    );
  }

  /** 利用者の設定に、DB が推定した種類を入れたもの（実行にもこの種類を使う） */
  private get effectiveConfig(): ReportConfig {
    return withGuessedTypes(this.config, this.guessed);
  }

  /** 接続を使う準備：入力欄の種類の推定と、選択肢の候補の取得。どちらも失敗しても画面は使える */
  private loadFromDb(): void {
    if (!this.connection) return;
    void this.guessTypes();
    this.loadOptions();
  }

  /**
   * 種類を設定していない入力欄があれば、DB に推定させる（D-35。SQL Server だけ）。
   * 未接続なら接続する。同じ接続・同じ SQL では推定し直さない
   */
  private async guessTypes(): Promise<void> {
    const { connection } = this;
    if (!connection) return;
    const configured = this.config.params ?? {};
    const untyped = this.params.some(
      (p) => !(Object.hasOwn(configured, p.name) && configured[p.name]?.type),
    );
    if (!untyped) return;
    let probe: ReturnType<typeof reportParamProbe>;
    try {
      probe = reportParamProbe(connection.dialect, this.text);
    } catch {
      // SQL の誤りは、実行するときにエラーとして出す
      return;
    }
    const key = `${connection.name}\n${probe.sql}`;
    if (key === this.guessKey) return;
    this.guessKey = key;
    let guessed: GuessedParamTypes = {};
    try {
      const session = await this.deps.openSession();
      if (!session.guessParamTypes) return;
      guessed = guessReportParamTypes(
        probe,
        await session.guessParamTypes(probe),
      );
    } catch {
      // 接続できない・推定できないときは、種類は文字列のまま（次に SQL を書き換えたときに試し直す）
      if (this.guessKey === key) this.guessKey = null;
      return;
    }
    // 推定の間に SQL や接続が変わっていたら、その結果は使わない
    if (this.guessKey !== key || this.disposed) return;
    const before = JSON.stringify(this.params.map((p) => p.type));
    this.guessed = guessed;
    this.parse(this.values, false);
    if (JSON.stringify(this.params.map((p) => p.type)) !== before) {
      this.deps.onValuesChanged?.(this.values);
      this.postInit();
      this.loadOptions();
    }
  }

  /** 選択肢の入力欄の候補を取る。候補の SQL と接続が変わっていなければ、取り直さない */
  private loadOptions(): void {
    const { connection } = this;
    const wanted = new Map<string, string>();
    for (const p of this.params) {
      if (p.type === "select" && connection) {
        wanted.set(p.name, `${connection.name}\n${p.options}`);
      }
    }
    for (const [name, entry] of this.options) {
      if (wanted.get(name) !== entry.key) {
        entry.abort.abort();
        this.options.delete(name);
      }
    }
    for (const [name, key] of wanted) {
      if (this.options.has(name)) continue;
      const param = this.params.find((p) => p.name === name);
      if (!param || !connection) continue;
      const entry = {
        key,
        state: { status: "loading" } as ReportOptionsState,
        abort: new AbortController(),
      };
      this.options.set(name, entry);
      this.post({ type: "options", name, state: entry.state });
      void this.fetchOptions(connection, param, entry.abort.signal).then(
        (state) => {
          if (this.options.get(name) !== entry) return;
          entry.state = state;
          this.post({ type: "options", name, state });
        },
      );
    }
  }

  private async fetchOptions(
    connection: ReportConnection,
    param: ReportParam,
    signal: AbortSignal,
  ): Promise<ReportOptionsState> {
    if (!param.options.trim()) {
      return {
        status: "error",
        message: "候補の SQL がありません（⚙ 入力欄で書いてください）",
      };
    }
    // 上限 + 1 行まで取ったら、残りは取らずに止める
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener("abort", stop, { once: true });
    const rows: CellValue[][] = [];
    try {
      const built = buildOptionsQuery(connection.dialect, param.options);
      const session = await this.deps.openSession();
      await session.query(
        {
          sql: built.sql,
          params: built.params,
          intent: {
            kind: "rows",
            source: { kind: "baseSql", sql: param.options },
            sort: [],
            limit: OPTIONS_LIMIT + 1,
          },
        },
        {
          signal: abort.signal,
          onColumns: () => {},
          onRows: (chunk) => {
            rows.push(...chunk);
            if (rows.length > OPTIONS_LIMIT) abort.abort();
          },
        },
      );
    } catch (error) {
      if (!(isAbortError(error) && !signal.aborted)) {
        return {
          status: "error",
          message: `候補を取れませんでした：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } finally {
      signal.removeEventListener("abort", stop);
    }
    return {
      status: "ok",
      options: toOptions(rows.slice(0, OPTIONS_LIMIT)),
      truncated: rows.length > OPTIONS_LIMIT,
    };
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
        options: Object.fromEntries(
          [...this.options].map(([name, { state }]) => [name, state]),
        ),
      },
    });
    this.postPreview();
  }

  private get source(): QuerySource {
    return {
      kind: "report",
      sql: this.text,
      config: this.effectiveConfig,
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
      config: this.effectiveConfig,
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
 * 候補の行 → 選択肢。値が空（NULL・空文字）の行は「指定なし」と重なるので除く。
 * 同じ値が何度も出てきたら、最初のものだけを残す
 */
function toOptions(rows: readonly CellValue[][]): ReportOption[] {
  const text = (value: CellValue | undefined) =>
    value === null || value === undefined ? "" : String(value);
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const value = text(row[0]);
    if (value === "" || seen.has(value)) return [];
    seen.add(value);
    return [{ value, label: text(row[1]) }];
  });
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
