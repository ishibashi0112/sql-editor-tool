import {
  isAbortError,
  type QueryHandlers,
  type QueryRequest,
} from "@sql-editor-tool/host";
import type oracledb from "oracledb";
import { describe, expect, test } from "vitest";
import {
  type OracleConnection,
  type OraclePool,
  OracleSession,
} from "./session";

type Reply = { columns: string[]; rows: unknown[][] };

/** execute の結果を、getRows で少しずつ返す偽の接続 */
class FakeConnection implements OracleConnection {
  readonly executed: { sql: string; binds: oracledb.BindParameters }[] = [];
  breakCount = 0;
  pingCount = 0;
  closedWith: { drop: boolean } | null = null;
  resultSetClosed = false;
  /** getRows が呼ばれたときに実行する処理（中断の確認用） */
  onGetRows: (() => void) | null = null;

  constructor(private readonly reply: (sql: string) => Reply) {}

  async execute(sql: string, binds: oracledb.BindParameters) {
    this.executed.push({ sql, binds });
    const { columns, rows } = this.reply(sql);
    let offset = 0;
    const resultSet = {
      getRows: async (size: number) => {
        this.onGetRows?.();
        const chunk = rows.slice(offset, offset + size);
        offset += chunk.length;
        return chunk;
      },
      close: async () => {
        this.resultSetClosed = true;
      },
    };
    return {
      metaData: columns.map((name) => ({ name })),
      resultSet,
    } as unknown as oracledb.Result<unknown[]>;
  }

  async break(): Promise<void> {
    this.breakCount += 1;
  }

  async ping(): Promise<void> {
    this.pingCount += 1;
    // 実際の接続では、break() の後の最初の往復で中止の知らせ（ORA-01013）が届く
    if (this.breakCount > 0 && this.pingCount === 1) {
      throw new Error("ORA-01013: user requested cancel of current operation");
    }
  }

  async close(options: { drop: boolean }): Promise<void> {
    this.closedWith = options;
  }
}

function sessionWith(reply: (sql: string) => Reply) {
  const connections: FakeConnection[] = [];
  const pool: OraclePool = {
    getConnection: async () => {
      const connection = new FakeConnection(reply);
      connections.push(connection);
      return connection;
    },
    close: async () => {},
  };
  return { session: new OracleSession(pool), connections };
}

const rowsIntent: QueryRequest["intent"] = {
  kind: "rows",
  source: { kind: "table", table: { schema: "APP", name: "ORDERS" } },
  sort: [],
  limit: 10,
};

function collect(signal = new AbortController().signal) {
  const result = {
    names: [] as string[],
    types: [] as string[],
    chunks: [] as unknown[][][],
  };
  const handlers: QueryHandlers = {
    signal,
    onColumns: (columns) => {
      result.names = columns.map((column) => column.name);
      result.types = columns.map((column) => column.type.kind);
    },
    onRows: (rows) => {
      result.chunks.push(rows);
    },
  };
  return { result, handlers };
}

describe("OracleSession.query", () => {
  test("列名を先に渡し、最初は少なく、あとはまとめて行を渡す", async () => {
    const rows = Array.from({ length: 1250 }, (_, i) => [i, `N${i}`]);
    const { session, connections } = sessionWith(() => ({
      columns: ["ID", "NAME"],
      rows,
    }));
    const { result, handlers } = collect();
    await session.query(
      {
        sql: 'SELECT * FROM "APP"."ORDERS" WHERE "NAME" = :p1',
        params: [
          { name: "p1", value: "N1", type: { kind: "string", unicode: false } },
        ],
        intent: rowsIntent,
      },
      handlers,
    );
    expect(result.names).toEqual(["ID", "NAME"]);
    expect(result.chunks.map((chunk) => chunk.length)).toEqual([
      100, 1000, 150,
    ]);
    const connection = connections[0];
    expect(Object.keys(connection?.executed[0]?.binds ?? {})).toEqual(["p1"]);
    expect(connection?.resultSetClosed).toBe(true);
    // 正常に終わった接続はプールに戻す
    expect(connection?.closedWith).toEqual({ drop: false });
  });

  test("中断されたら break() で DB 側も止め、接続は捨てて AbortError", async () => {
    const abort = new AbortController();
    const { session, connections } = sessionWith(() => ({
      columns: ["ID"],
      rows: Array.from({ length: 5000 }, (_, i) => [i]),
    }));
    const { result, handlers } = collect(abort.signal);
    const running = session.query(
      { sql: "SELECT * FROM t", params: [], intent: rowsIntent },
      {
        ...handlers,
        onRows: (rows) => {
          handlers.onRows(rows);
          abort.abort();
        },
      },
    );
    await expect(running).rejects.toSatisfy(isAbortError);
    expect(result.chunks).toHaveLength(1);
    expect(connections[0]?.breakCount).toBe(1);
    // 中止の知らせを ping で受け切ってから閉じる（次に使う文が ORA-01013 にならないように）
    expect(connections[0]?.pingCount).toBe(1);
    expect(connections[0]?.closedWith).toEqual({ drop: true });
  });

  test("DB のエラーはそのまま返し、接続はプールに戻す", async () => {
    const { session, connections } = sessionWith(() => {
      throw new Error("ORA-00942: table or view does not exist");
    });
    await expect(
      session.query(
        { sql: "SELECT * FROM t", params: [], intent: rowsIntent },
        collect().handlers,
      ),
    ).rejects.toThrow("ORA-00942");
    expect(connections[0]?.pingCount).toBe(0);
    expect(connections[0]?.closedWith).toEqual({ drop: false });
  });

  test("SELECT / WITH 以外は接続する前に止める", async () => {
    const { session, connections } = sessionWith(() => ({
      columns: [],
      rows: [],
    }));
    await expect(
      session.query(
        { sql: "UPDATE t SET x = 1", params: [], intent: rowsIntent },
        collect().handlers,
      ),
    ).rejects.toThrow("読み取り専用");
    expect(connections).toHaveLength(0);
  });
});

describe("OracleSession のメタデータ", () => {
  test("テーブルとビューを分ける", async () => {
    const { session, connections } = sessionWith(() => ({
      columns: ["TABLE_NAME", "'T'"],
      rows: [
        ["ORDERS", "T"],
        ["V_ORDERS", "V"],
      ],
    }));
    expect(await session.listObjects("APP")).toEqual([
      { name: "ORDERS", kind: "table" },
      { name: "V_ORDERS", kind: "view" },
    ]);
    expect(connections[0]?.executed[0]?.binds).toEqual({ owner: "APP" });
  });

  test("すべてのスキーマのテーブルとビューを 1 回で取る（テーブル検索用）", async () => {
    const { session, connections } = sessionWith(() => ({
      columns: ["OWNER", "TABLE_NAME", "'T'"],
      rows: [
        ["APP", "ORDERS", "T"],
        ["SALES", "V_ORDERS", "V"],
      ],
    }));
    expect(await session.listAllObjects()).toEqual([
      { schema: "APP", name: "ORDERS", kind: "table" },
      { schema: "SALES", name: "V_ORDERS", kind: "view" },
    ]);
    expect(connections[0]?.executed).toHaveLength(1);
  });

  test("列の型と主キーを返す（精度の指定がない NUMBER の長さなどは文字列で届く）", async () => {
    const { session } = sessionWith((sql) =>
      sql.includes("ALL_TAB_COLUMNS")
        ? {
            columns: [],
            rows: [
              ["ORDER_NO", "VARCHAR2", "20", "20", "B", null, null],
              ["AMOUNT", "NUMBER", "22", "0", null, "12", "2"],
            ],
          }
        : { columns: [], rows: [["ORDER_NO"]] },
    );
    expect(
      await session.describeTable({ schema: "APP", name: "ORDERS" }),
    ).toEqual({
      columns: [
        {
          name: "ORDER_NO",
          type: {
            kind: "string",
            unicode: false,
            fixedLength: false,
            length: 20,
          },
        },
        {
          name: "AMOUNT",
          type: { kind: "number", precision: 12, scale: 2 },
        },
      ],
      primaryKey: ["ORDER_NO"],
    });
  });
});
