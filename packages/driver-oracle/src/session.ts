// Oracle のセッション（DbSession の実装）。node-oracledb の接続プールを使う

import { assertReadOnlyQuery, type TableRef } from "@sql-editor-tool/core";
import {
  abortError,
  type CellValue,
  type DbObject,
  type DbSession,
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
  close(options: { drop: boolean }): Promise<void>;
};

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
      connectString: `${config.host}:${config.port}/${config.serviceName}`,
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
    }));
  }

  async listAllObjects(): Promise<SchemaObject[]> {
    const rows = await this.select(LIST_ALL_OBJECTS_SQL, {});
    return rows.map((row) => ({
      schema: String(row[0]),
      name: String(row[1]),
      kind: row[2] === "V" ? "view" : "table",
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
    let broken = false;
    const onAbort = () => {
      broken = true;
      connection.break().catch(() => {});
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
      handlers.onColumns((result.metaData ?? []).map((column) => column.name));
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
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      // break() した接続は状態が分からないので、プールに戻さずに閉じる
      await connection.close({ drop: broken }).catch(() => {});
    }
  }
}
