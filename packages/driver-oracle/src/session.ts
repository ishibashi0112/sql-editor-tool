// Oracle のセッション（DbSession の実装）。node-oracledb の接続プールを使う

import {
  assertReadOnlyQuery,
  splitDbComment,
  type TableRef,
} from "@sql-editor-tool/core";
import {
  abortError,
  type CellValue,
  type DbObject,
  DbQueryError,
  type DbSession,
  lineAt,
  type QueryHandlers,
  type QueryRequest,
  type SchemaObject,
  type TableDescription,
} from "@sql-editor-tool/host";
import oracledb from "oracledb";
import {
  DESCRIBE_COLUMNS_SQL,
  LIST_ALL_OBJECTS_SQL,
  LIST_OBJECTS_SQL,
  LIST_SCHEMAS_SQL,
  PRIMARY_KEY_SQL,
  resultColumnType,
  toColumnType,
} from "./metadata";
import { fetchTypeHandler, toBinds, toCellValue } from "./values";

export type OracleConfig = {
  host: string;
  port: number;
  serviceName: string;
  user: string;
  password: string;
};

/**
 * Thin モード（既定。Oracle Client が要らない）か Thick モード（Oracle Client を使う）か。
 * Thin で繋がらなかったときの切り替え先（D-21）。プロセスで 1 回しか決められない
 */
export type OracleClientMode =
  | { mode: "thin" }
  | {
      mode: "thick";
      /** Oracle Client のライブラリのフォルダ。省略時は PATH から探す */
      libDir?: string | undefined;
      /** node-oracledb の Thick モード用のバイナリ（.node）のフォルダ。拡張に同梱したものを指す */
      binaryDir?: string | undefined;
    };

/** セッションが使う接続の部分（テストでは差し替える） */
export type OracleConnection = {
  execute(
    sql: string,
    binds: oracledb.BindParameters,
    options: oracledb.ExecuteOptions,
  ): Promise<oracledb.Result<unknown[]>>;
  break(): Promise<void>;
  ping(): Promise<void>;
  close(options: { drop: boolean }): Promise<void>;
};

/** 中止の後始末（ping）を待つ上限。応答がなければ待たずに接続を閉じる */
const CLEANUP_TIMEOUT_MS = 5000;

export type OraclePool = {
  getConnection(): Promise<OracleConnection>;
  close(drainTime: number): Promise<void>;
};

let initializedMode: "thin" | "thick" | null = null;

/** Thin / Thick を決める。一度決めたら、ウィンドウを再読み込みするまで変えられない */
export function initOracleClient(mode: OracleClientMode): void {
  if (initializedMode === mode.mode) return;
  if (initializedMode !== null) {
    throw new Error(
      `Oracle のドライバはすでに ${initializedMode === "thin" ? "Thin" : "Thick"} モードで動いています。切り替えるには、ウィンドウを再読み込みしてください`,
    );
  }
  if (mode.mode === "thick") {
    oracledb.initOracleClient({
      ...(mode.libDir ? { libDir: mode.libDir } : {}),
      ...(mode.binaryDir ? { binaryDir: mode.binaryDir } : {}),
    });
  }
  initializedMode = mode.mode;
}

/**
 * 接続先の記述子。Easy Connect（host:port/service）は、Thick モードで Oracle Client の sqlnet.ora の
 * NAMES.DIRECTORY_PATH に EZCONNECT がないと ORA-12154 になる（会社 PC で起きた。O-02）。
 * 完全な記述子なら、名前の解決を使わないので Thin・Thick のどちらでも通る
 */
export function connectDescriptor(
  config: Pick<OracleConfig, "host" | "port" | "serviceName">,
): string {
  const host = config.host.trim();
  const serviceName = config.serviceName.trim();
  // 記述子の区切りの文字が入ると、別の指定として読まれてしまう
  for (const [label, value] of [
    ["ホスト名", host],
    ["サービス名", serviceName],
  ] as const) {
    if (!value || /[()=\s]/.test(value)) {
      throw new Error(
        `Oracle の${label}「${value}」に使えない文字（括弧・=・空白）があるか、空です`,
      );
    }
  }
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error(`Oracle のポート「${config.port}」が正しくありません`);
  }
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${config.port}))(CONNECT_DATA=(SERVICE_NAME=${serviceName})))`;
}

/** 最初の数行はすぐ画面に出したいので少なく取り、そのあとはまとめて取る */
const FIRST_FETCH_ROWS = 100;
const FETCH_ROWS = 1000;

export class OracleSession implements DbSession {
  readonly dialect = "oracle";

  /** 接続を 1 本開いて確かめてから返す（パスワードの誤りなどを、ここで出す） */
  static async open(
    config: OracleConfig,
    mode: OracleClientMode,
  ): Promise<OracleSession> {
    initOracleClient(mode);
    const pool = await oracledb.createPool({
      // パスワードは node-oracledb に渡すだけで、表示もログ出力もしない（§8）
      user: config.user,
      password: config.password,
      connectString: connectDescriptor(config),
      poolMin: 0,
      poolMax: 4,
      poolIncrement: 1,
      // 使われないまま 5 分過ぎた接続は閉じる（秒）
      poolTimeout: 300,
    });
    try {
      const connection = await pool.getConnection();
      await connection.close();
    } catch (error) {
      await pool.close(0);
      throw error;
    }
    return new OracleSession(pool);
  }

  constructor(private readonly pool: OraclePool) {}

  async listSchemas(): Promise<string[]> {
    const rows = await this.select(LIST_SCHEMAS_SQL, {});
    return rows.map((row) => String(row[0]));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const rows = await this.select(LIST_OBJECTS_SQL, { owner: schema });
    return rows.map((row) => ({
      name: String(row[0]),
      kind: row[1] === "V" ? "view" : "table",
      ...splitDbComment(textOrNull(row[2])),
    }));
  }

  async listAllObjects(): Promise<SchemaObject[]> {
    const rows = await this.select(LIST_ALL_OBJECTS_SQL, {});
    return rows.map((row) => ({
      schema: String(row[0]),
      name: String(row[1]),
      kind: row[2] === "V" ? "view" : "table",
      ...splitDbComment(textOrNull(row[3])),
    }));
  }

  async describeTable(table: TableRef): Promise<TableDescription> {
    const binds = { owner: table.schema, name: table.name };
    const columns = await this.select(DESCRIBE_COLUMNS_SQL, binds);
    if (columns.length === 0) {
      throw new Error(
        `テーブル「${table.schema}.${table.name}」が見つかりません（参照権限がない可能性もあります）`,
      );
    }
    const primaryKey = await this.select(PRIMARY_KEY_SQL, binds);
    return {
      columns: columns.map(
        ([
          name,
          dataType,
          dataLength,
          charLength,
          charUsed,
          precision,
          scale,
          comment,
        ]) => ({
          name: String(name),
          type: toColumnType({
            dataType: String(dataType),
            dataLength: Number(dataLength),
            charLength: Number(charLength),
            charUsed: charUsed === null ? null : String(charUsed),
            precision: precision === null ? null : Number(precision),
            scale: scale === null ? null : Number(scale),
          }),
          ...splitDbComment(textOrNull(comment)),
        }),
      ),
      primaryKey: primaryKey.map((row) => String(row[0])),
    };
  }

  async query(request: QueryRequest, handlers: QueryHandlers): Promise<void> {
    assertReadOnlyQuery("oracle", request.sql);
    await this.execute(request.sql, toBinds(request.params), handlers);
  }

  async close(): Promise<void> {
    // 実行中の問い合わせがあっても待たずに閉じる
    await this.pool.close(0);
  }

  /** メタデータの取得。結果は小さいので、まとめて返す */
  private async select(
    sql: string,
    binds: Record<string, string>,
  ): Promise<CellValue[][]> {
    assertReadOnlyQuery("oracle", sql);
    const rows: CellValue[][] = [];
    await this.execute(sql, binds, {
      signal: new AbortController().signal,
      onColumns: () => {},
      onRows: (chunk) => rows.push(...chunk),
    });
    return rows;
  }

  /** 1 つの問い合わせを実行し、行をまとめて渡す。中断されたら connection.break() で DB 側も止める */
  private async execute(
    sql: string,
    binds: oracledb.BindParameters,
    handlers: QueryHandlers,
  ): Promise<void> {
    const { signal } = handlers;
    if (signal.aborted) throw abortError();
    const connection = await this.pool.getConnection();
    let breaking: Promise<void> | null = null;
    const onAbort = () => {
      breaking = connection.break().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // 接続を待っている間に中断された
      if (signal.aborted) throw abortError();
      const result = await connection.execute(sql, binds, {
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        fetchTypeHandler,
      });
      handlers.onColumns(
        (result.metaData ?? []).map((column) => ({
          name: column.name,
          type: resultColumnType(column),
        })),
      );
      const { resultSet } = result;
      if (!resultSet) return;
      try {
        for (let size = FIRST_FETCH_ROWS; ; size = FETCH_ROWS) {
          if (signal.aborted) throw abortError();
          const rows = await resultSet.getRows(size);
          if (rows.length === 0) break;
          handlers.onRows(rows.map((row) => row.map(toCellValue)));
        }
      } finally {
        await resultSet.close().catch(() => {});
      }
    } catch (error) {
      // break() で止めたときは ORA-01013 などになる
      if (signal.aborted) throw abortError();
      throw toQueryError(error, sql);
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (breaking) {
        // break() の後は、中止の知らせ（ORA-01013）が接続に残り、次に実行した文が失敗する。
        // 捨てるつもりの接続もプールに戻ることがある（Thin モードで確かめた）ので、ping で知らせを受け切ってから返す
        await breaking;
        await withTimeout(connection.ping(), CLEANUP_TIMEOUT_MS).catch(
          () => {},
        );
      }
      await connection.close({ drop: breaking !== null }).catch(() => {});
    }
  }
}

/**
 * node-oracledb のエラーを DbQueryError にする。offset（SQL の中のエラーの位置）があれば、行にして画面に出す（O-18）
 */
export function toQueryError(error: unknown, sql: string): unknown {
  if (!(error instanceof Error)) return error;
  const offset = (error as { offset?: unknown }).offset;
  const line =
    typeof offset === "number" && offset > 0 ? lineAt(sql, offset) : undefined;
  return new DbQueryError(
    [{ message: error.message, ...(line ? { line } : {}) }],
    error.message,
  );
}

function textOrNull(value: CellValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
