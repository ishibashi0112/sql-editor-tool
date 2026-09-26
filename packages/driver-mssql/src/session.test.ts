import type { EventEmitter } from "node:events";
import {
  isAbortError,
  type QueryHandlers,
  type QueryRequest,
} from "@sql-editor-tool/host";
import { type Request, TYPES } from "tedious";
import { describe, expect, test } from "vitest";
import { MssqlSession, type SqlConnection } from "./session";

type Column = { colName: string; type: { name: string } };

/** execSql で受けた Request に、実際の tedious と同じイベントを出す偽の接続 */
class FakeConnection implements SqlConnection {
  closed = false;
  cancelCount = 0;
  readonly requests: Request[] = [];
  private current: Request | null = null;

  constructor(
    private readonly respond: (sql: string, connection: FakeConnection) => void,
  ) {}

  execSql(request: Request): void {
    this.requests.push(request);
    this.current = request;
    this.respond(String(request.sqlTextOrProcedure), this);
  }

  cancel(): boolean {
    this.cancelCount += 1;
    // tedious は中止の確認を受けてから、完了のコールバックを ECANCEL で呼ぶ
    queueMicrotask(() =>
      this.finish(Object.assign(new Error("Canceled."), { code: "ECANCEL" })),
    );
    return true;
  }

  close(): void {
    this.closed = true;
  }

  // 偽の列情報は tedious の ColumnMetadata の一部だけなので、型を合わせずに出す
  columns(columns: Column[]): void {
    (this.current as EventEmitter | null)?.emit("columnMetadata", columns);
  }

  row(values: unknown[]): void {
    this.current?.emit(
      "row",
      values.map((value) => ({ value })),
    );
  }

  finish(error: Error | null = null): void {
    const request = this.current;
    this.current = null;
    request?.callback(error ?? undefined);
  }
}

function sessionWith(respond: (sql: string, c: FakeConnection) => void) {
  const connections: FakeConnection[] = [];
  const session = new MssqlSession(async () => {
    const connection = new FakeConnection(respond);
    connections.push(connection);
    return connection;
  });
  return { session, connections };
}

function collect(signal = new AbortController().signal) {
  const result = { names: [] as string[], rows: [] as unknown[][] };
  const handlers: QueryHandlers = {
    signal,
    onColumns: (names) => {
      result.names = names;
    },
    onRows: (rows) => {
      result.rows.push(...rows);
    },
  };
  return { result, handlers };
}

const rowsIntent: QueryRequest["intent"] = {
  kind: "rows",
  source: { kind: "table", table: { schema: "APP", name: "ORDERS" } },
  sort: [],
  limit: 10,
};

describe("MssqlSession.query", () => {
  test("列名を先に渡し、値をセルの値にして行を渡す", async () => {
    const { session } = sessionWith((_, c) => {
      c.columns([
        { colName: "ORDER_NO", type: { name: "NVarChar" } },
        { colName: "ORDERED_AT", type: { name: "DateTimeN" } },
        { colName: "SHIPPED", type: { name: "BitN" } },
      ]);
      c.row(["A001", new Date("2026-09-01T10:00:00Z"), true]);
      c.row(["A002", null, false]);
      c.finish();
    });
    const { result, handlers } = collect();
    await session.query(
      { sql: "SELECT * FROM [APP].[ORDERS]", params: [], intent: rowsIntent },
      handlers,
    );
    expect(result.names).toEqual(["ORDER_NO", "ORDERED_AT", "SHIPPED"]);
    expect(result.rows).toEqual([
      ["A001", "2026-09-01 10:00:00", 1],
      ["A002", null, 0],
    ]);
  });

  test("バインド変数を tedious のパラメータにする", async () => {
    const { session, connections } = sessionWith((_, c) => {
      c.columns([{ colName: "X", type: { name: "Int" } }]);
      c.finish();
    });
    await session.query(
      {
        sql: "SELECT TOP (@p1) * FROM [APP].[ORDERS] WHERE [CUST_CD] = @p2",
        params: [
          { name: "p1", value: 11, type: { kind: "integer" } },
          {
            name: "p2",
            value: "C01",
            type: { kind: "string", unicode: false },
          },
        ],
        intent: rowsIntent,
      },
      collect().handlers,
    );
    const parameters = connections[0]?.requests[0]?.parameters ?? [];
    expect(parameters.map((p) => [p.name, p.type, p.value])).toEqual([
      ["p1", TYPES.Int, 11],
      ["p2", TYPES.VarChar, "C01"],
    ]);
  });

  test("中断されたら DB 側も止め（cancel）、AbortError を投げる", async () => {
    const abort = new AbortController();
    const { session, connections } = sessionWith((_, c) => {
      c.columns([{ colName: "X", type: { name: "Int" } }]);
      c.row([1]);
      abort.abort();
      // 中止の確認が届くまでに来た行は捨てる
      c.row([2]);
    });
    const { result, handlers } = collect(abort.signal);
    await expect(
      session.query(
        { sql: "SELECT * FROM t", params: [], intent: rowsIntent },
        handlers,
      ),
    ).rejects.toSatisfy(isAbortError);
    expect(connections[0]?.cancelCount).toBe(1);
    expect(result.rows.flat()).not.toContain(2);
  });

  test("受け取る側が投げた例外は、実行を止めてからそのまま返す", async () => {
    const { session, connections } = sessionWith((_, c) => {
      c.columns([{ colName: "X", type: { name: "Int" } }]);
    });
    const handlers: QueryHandlers = {
      signal: new AbortController().signal,
      onColumns: () => {
        throw new Error("列が合いません");
      },
      onRows: () => {},
    };
    await expect(
      session.query(
        { sql: "SELECT * FROM t", params: [], intent: rowsIntent },
        handlers,
      ),
    ).rejects.toThrow("列が合いません");
    expect(connections[0]?.cancelCount).toBe(1);
  });

  test("DB のエラーはそのまま返し、接続は次にも使う", async () => {
    let calls = 0;
    const { session, connections } = sessionWith((_, c) => {
      calls += 1;
      if (calls === 1) c.finish(new Error("Invalid object name 'X'."));
      else {
        c.columns([{ colName: "X", type: { name: "Int" } }]);
        c.finish();
      }
    });
    const request = { sql: "SELECT * FROM t", params: [], intent: rowsIntent };
    await expect(session.query(request, collect().handlers)).rejects.toThrow(
      "Invalid object name",
    );
    await session.query(request, collect().handlers);
    expect(connections).toHaveLength(1);
  });

  test("SELECT / WITH 以外は接続する前に止める", async () => {
    const { session, connections } = sessionWith(() => {});
    await expect(
      session.query(
        { sql: "DELETE FROM t", params: [], intent: rowsIntent },
        collect().handlers,
      ),
    ).rejects.toThrow("読み取り専用");
    expect(connections).toHaveLength(0);
  });
});

describe("MssqlSession のメタデータ", () => {
  test("テーブルとビューを分ける（type は char(2)）", async () => {
    const { session } = sessionWith((_, c) => {
      c.columns([
        { colName: "name", type: { name: "NVarChar" } },
        { colName: "type", type: { name: "Char" } },
      ]);
      c.row(["ORDERS", "U "]);
      c.row(["V_ORDERS", "V "]);
      c.finish();
    });
    expect(await session.listObjects("APP")).toEqual([
      { name: "ORDERS", kind: "table" },
      { name: "V_ORDERS", kind: "view" },
    ]);
  });

  test("すべてのスキーマのテーブルとビューを 1 回で取る（テーブル検索用）", async () => {
    const { session, connections } = sessionWith((_, c) => {
      c.columns([]);
      c.row(["dbo", "ORDERS", "U "]);
      c.row(["sales", "V_ORDERS", "V "]);
      c.finish();
    });
    expect(await session.listAllObjects()).toEqual([
      { schema: "dbo", name: "ORDERS", kind: "table" },
      { schema: "sales", name: "V_ORDERS", kind: "view" },
    ]);
    expect(connections[0]?.requests).toHaveLength(1);
  });

  test("列の型と主キーを返す", async () => {
    const { session } = sessionWith((sql, c) => {
      if (sql.includes("sys.columns c\nJOIN sys.objects")) {
        c.columns([]);
        c.row(["ORDER_NO", "nvarchar", 20, 0, 0]);
        c.row(["AMOUNT", "decimal", 17, 19, 2]);
      } else {
        c.columns([]);
        c.row(["ORDER_NO"]);
      }
      c.finish();
    });
    expect(
      await session.describeTable({ schema: "APP", name: "ORDERS" }),
    ).toEqual({
      columns: [
        {
          name: "ORDER_NO",
          type: {
            kind: "string",
            unicode: true,
            fixedLength: false,
            length: 10,
          },
        },
        {
          name: "AMOUNT",
          type: { kind: "number", precision: 19, scale: 2, asText: true },
        },
      ],
      primaryKey: ["ORDER_NO"],
    });
  });

  test("列が 1 つもなければ、見つからないとして止める", async () => {
    const { session } = sessionWith((_, c) => {
      c.columns([]);
      c.finish();
    });
    await expect(
      session.describeTable({ schema: "APP", name: "NO_SUCH" }),
    ).rejects.toThrow("見つかりません");
  });
});
