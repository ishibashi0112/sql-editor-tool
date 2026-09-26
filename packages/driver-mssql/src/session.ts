// SQL Server のセッション（DbSession の実装）。tedious を直接使う（Hayami と同じ。D-07）

import {
  assertReadOnlyQuery,
  type BoundParam,
  type TableRef,
} from "@sql-editor-tool/core";
import {
  abortError,
  type CellValue,
  type DbObject,
  type DbSession,
  type QueryHandlers,
  type QueryRequest,
  type TableDescription,
} from "@sql-editor-tool/host";
import { Connection, Request } from "tedious";
import {
  DESCRIBE_COLUMNS_SQL,
  LIST_OBJECTS_SQL,
  LIST_SCHEMAS_SQL,
  PRIMARY_KEY_SQL,
  toColumnType,
} from "./metadata";
import { Pool } from "./pool";
import { type TediousParam, toCellValue, toTediousParam } from "./values";

export type MssqlConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /**
   * TLS の最低のバージョン（例 'TLSv1'）。省略時は Node の既定（TLS 1.2 以上）。
   * encrypt: false でもログインの間だけ TLS を使うので、古いサーバーで TLS のエラーになったときに指定する
   */
  tlsMinVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | undefined;
};

/** セッションが使う tedious の Connection の部分（テストでは差し替える） */
export type SqlConnection = {
  execSql(request: Request): void;
  cancel(): boolean;
  close(): void;
  /** 切断されたら true */
  readonly closed: boolean;
};

export type MssqlSessionOptions = {
  /** 同時に開く接続の上限 */
  maxConnections?: number;
  /** 使われないままこの時間が過ぎた接続は閉じる（ミリ秒） */
  idleMs?: number;
};

export class MssqlSession implements DbSession {
  readonly dialect = "mssql";
  private readonly pool: Pool<SqlConnection>;

  /** 接続を 1 本開いて確かめてから返す（パスワードの誤りなどを、ここで出す） */
  static async open(config: MssqlConfig): Promise<MssqlSession> {
    const session = new MssqlSession(() => connect(config));
    try {
      await session.pool.warmUp();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  constructor(
    connect: () => Promise<SqlConnection>,
    options: MssqlSessionOptions = {},
  ) {
    this.pool = new Pool({
      create: connect,
      destroy: (connection) => connection.close(),
      isBroken: (connection) => connection.closed,
      max: options.maxConnections ?? 4,
      idleMs: options.idleMs ?? 5 * 60_000,
    });
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.select(LIST_SCHEMAS_SQL, []);
    return rows.map((row) => String(row[0]));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const rows = await this.select(LIST_OBJECTS_SQL, [
      nameParam("schema", schema),
    ]);
    return rows.map((row) => ({
      name: String(row[0]),
      // sys.objects.type は char(2)（'U ' / 'V '）
      kind: String(row[1]).trim() === "V" ? "view" : "table",
    }));
  }

  async describeTable(table: TableRef): Promise<TableDescription> {
    const params = [
      nameParam("schema", table.schema),
      nameParam("name", table.name),
    ];
    const columns = await this.select(DESCRIBE_COLUMNS_SQL, params);
    if (columns.length === 0) {
      throw new Error(
        `テーブル「${table.schema}.${table.name}」が見つかりません（参照権限がない可能性もあります）`,
      );
    }
    const primaryKey = await this.select(PRIMARY_KEY_SQL, params);
    return {
      columns: columns.map(([name, typeName, maxLength, precision, scale]) => ({
        name: String(name),
        type: toColumnType({
          typeName: String(typeName),
          maxLength: Number(maxLength),
          precision: Number(precision),
          scale: Number(scale),
        }),
      })),
      primaryKey: primaryKey.map((row) => String(row[0])),
    };
  }

  async query(request: QueryRequest, handlers: QueryHandlers): Promise<void> {
    assertReadOnlyQuery("mssql", request.sql);
    const params = request.params.map(toTediousParam);
    await this.pool.use(handlers.signal, (connection) =>
      execute(connection, request.sql, params, handlers),
    );
  }

  async close(): Promise<void> {
    this.pool.close();
  }

  /** メタデータの取得。結果は小さいので、まとめて返す */
  private async select(
    sql: string,
    params: BoundParam[],
  ): Promise<CellValue[][]> {
    assertReadOnlyQuery("mssql", sql);
    const rows: CellValue[][] = [];
    const signal = new AbortController().signal;
    await this.pool.use(signal, (connection) =>
      execute(connection, sql, params.map(toTediousParam), {
        signal,
        onColumns: () => {},
        onRows: (chunk) => rows.push(...chunk),
      }),
    );
    return rows;
  }
}

/** sysname（nvarchar(128)）と比べる名前 */
function nameParam(name: string, value: string): BoundParam {
  return { name, value, type: { kind: "string", unicode: true } };
}

function connect(config: MssqlConfig): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const connection = new Connection({
      server: config.host,
      // パスワードは tedious に渡すだけで、表示もログ出力もしない（§8）
      authentication: {
        type: "default",
        options: { userName: config.user, password: config.password },
      },
      options: {
        port: config.port,
        database: config.database,
        // Hayami の実測：社内の SQL Server 2012 は encrypt: false で接続できる
        encrypt: false,
        trustServerCertificate: true,
        ...(config.tlsMinVersion
          ? { cryptoCredentialsDetails: { minVersion: config.tlsMinVersion } }
          : {}),
        // 大きい取得でも時間で打ち切らない。止めるのは利用者の「中止」だけ
        requestTimeout: 0,
        appName: "sql-editor-tool",
        useColumnNames: false,
        rowCollectionOnDone: false,
        rowCollectionOnRequestCompletion: false,
      },
    });
    // 接続が切れたときの error をどこでも受けないと、拡張のプロセスが落ちる。切れた接続は closed で分かるので、ここでは何もしない
    connection.on("error", () => {});
    connection.connect((error) => {
      if (error) {
        connection.close();
        reject(error);
      } else {
        resolve(connection);
      }
    });
  });
}

const CHUNK_ROWS = 1000;
const CHUNK_WAIT_MS = 100;

/**
 * 1 つの問い合わせを実行し、行をまとめて渡す。
 * 行は 1000 行ごと、または前に渡してから 100ms 経ったら渡す（最初の行はすぐ画面に出す）
 */
export function execute(
  connection: SqlConnection,
  sql: string,
  params: TediousParam[],
  handlers: QueryHandlers,
): Promise<void> {
  const { signal } = handlers;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let types: string[] = [];
    let chunk: CellValue[][] = [];
    let flushedAt = Date.now();
    let cancelled = false;
    // 受け取った側（handlers）が投げた例外。覚えておいて、実行を止めてから返す
    let failure: { error: unknown } | null = null;

    const flush = () => {
      flushedAt = Date.now();
      if (chunk.length === 0) return;
      const rows = chunk;
      chunk = [];
      handlers.onRows(rows);
    };
    const guard = (fn: () => void) => {
      if (failure || cancelled) return;
      try {
        fn();
      } catch (error) {
        failure = { error };
        connection.cancel();
      }
    };
    const onAbort = () => {
      cancelled = true;
      connection.cancel();
    };

    const request = new Request(sql, (error) => {
      signal.removeEventListener("abort", onAbort);
      if (!error) guard(flush);
      if (failure) reject(failure.error);
      else if (cancelled) reject(abortError());
      else if (error) reject(error);
      else resolve();
    });
    for (const param of params) {
      request.addParameter(param.name, param.type, param.value, param.options);
    }
    request.on("columnMetadata", (columns) => {
      const list = Array.isArray(columns) ? columns : Object.values(columns);
      types = list.map((column) => column.type.name);
      guard(() => handlers.onColumns(list.map((column) => column.colName)));
    });
    request.on("row", (columns: { value: unknown }[]) => {
      guard(() => {
        chunk.push(
          columns.map((column, i) => toCellValue(column.value, types[i] ?? "")),
        );
        if (
          chunk.length >= CHUNK_ROWS ||
          Date.now() - flushedAt >= CHUNK_WAIT_MS
        ) {
          flush();
        }
      });
    });
    signal.addEventListener("abort", onAbort, { once: true });
    connection.execSql(request);
  });
}
