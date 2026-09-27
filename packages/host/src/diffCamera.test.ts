import type { ColumnInfo, TableRef } from "@sql-editor-tool/core";
import { describe, expect, test, vi } from "vitest";
import {
  compareShots,
  comparisonText,
  type DiffCamera,
  shoot,
} from "./diffCamera";
import { DiffCameraController } from "./diffCameraController";
import type { CameraItem, DiffView, ToCameraView } from "./diffCameraProtocol";
import type { SheetRow } from "./diffSheet";
import type { CellValue, DbSession, QueryRequest } from "./session";

// 架空の表。rows を書き換えると、次に撮ったときの中身が変わる
const text = {
  kind: "string",
  unicode: true,
  fixedLength: false,
  length: 10,
} as const;
const col = (name: string, logicalName?: string): ColumnInfo => ({
  name,
  type: text,
  ...(logicalName ? { logicalName } : {}),
});
type FakeTable = {
  columns: ColumnInfo[];
  primaryKey: string[];
  rows: CellValue[][];
};

function fakeDb(tables: Record<string, FakeTable>) {
  const requests: QueryRequest[] = [];
  const session: DbSession = {
    dialect: "mssql",
    listSchemas: async () => ["dbo"],
    listObjects: async () => [],
    listAllObjects: async () => [],
    describeTable: async (t: TableRef) => {
      const table = tables[t.name];
      if (!table)
        throw new Error(`テーブル「${t.schema}.${t.name}」が見つかりません`);
      return { columns: table.columns, primaryKey: table.primaryKey };
    },
    query: async (request, handlers) => {
      requests.push(request);
      const source = request.intent.source;
      const table =
        source.kind === "table" ? tables[source.table.name] : undefined;
      handlers.onColumns([]);
      const rows = (table?.rows ?? []).slice(0, request.intent.limit);
      // 数行ずつ届く（上限を超えたら中断されるか）
      for (let i = 0; i < rows.length; i += 2) {
        if (handlers.signal.aborted) {
          const error = new Error("中断しました");
          error.name = "AbortError";
          throw error;
        }
        handlers.onRows(rows.slice(i, i + 2).map((r) => [...r]));
      }
    },
    close: async () => {},
  };
  return { session, requests };
}

const stock = (): FakeTable => ({
  columns: [
    col("ITEM_CD", "品目コード"),
    col("WH_CD", "倉庫"),
    col("QTY", "在庫数"),
  ],
  primaryKey: ["ITEM_CD", "WH_CD"],
  rows: [
    ["A001", "01", "120"],
    ["A002", "01", "40"],
  ],
});

describe("shoot と compareShots", () => {
  test("主キーの順に撮り、条件は SQL に入れる。前後を比べて変わった列を出す", async () => {
    const db = { STOCK: stock() };
    const { session, requests } = fakeDb(db);
    const tables = [{ schema: "dbo", name: "STOCK", where: "WH_CD = '01'" }];
    const before = await shoot({
      session,
      dialect: "mssql",
      tables,
      maxRows: 10,
    });
    expect(requests[0]?.sql).toBe(
      "SELECT TOP (@p1) *\nFROM [dbo].[STOCK]\nWHERE (\nWH_CD = '01'\n)\nORDER BY [ITEM_CD] ASC, [WH_CD] ASC",
    );
    db.STOCK.rows = [
      ["A001", "01", "117"],
      ["A003", "01", "5"],
    ];
    const after = await shoot({
      session,
      dialect: "mssql",
      tables,
      maxRows: 10,
    });
    const [result] = compareShots(before, after);
    expect(result?.keySource).toBe("primary");
    expect(result?.diff).toMatchObject({
      changedRows: 1,
      added: 1,
      deleted: 1,
    });
    expect(comparisonText("見出し", compareShots(before, after))).toBe(
      [
        "見出し",
        "",
        "STOCK　変更 1 行・追加 1 行・削除 1 行",
        "✎ 品目コード=A001・倉庫=01　在庫数 120 → 117",
        "＋ 品目コード=A003・倉庫=01　在庫数=5",
        "− 品目コード=A002・倉庫=01　在庫数=40",
      ].join("\n"),
    );
  });

  test("主キーがなければ列の設定のキー、それもなければ行の中身全体。上限を超えた表・ない表は error で続ける", async () => {
    const db = {
      LOG: { ...stock(), primaryKey: [] },
      WORK: { ...stock(), primaryKey: [] },
      BIG: {
        ...stock(),
        rows: [
          ["1", "1", "1"],
          ["2", "2", "2"],
          ["3", "3", "3"],
        ],
      },
    };
    const { session } = fakeDb(db);
    const shot = await shoot({
      session,
      dialect: "mssql",
      tables: ["LOG", "WORK", "BIG", "NONE"].map((name) => ({
        schema: "dbo",
        name,
      })),
      maxRows: 2,
      keyColumns: (t) =>
        t.name === "LOG" ? ["ITEM_CD", "NO_SUCH_COLUMN"] : undefined,
    });
    expect(
      shot.tables.map((t) => [
        t.table.name,
        t.keySource,
        t.key,
        t.error ?? null,
      ]),
    ).toEqual([
      ["LOG", "settings", ["ITEM_CD"], null],
      ["WORK", "none", [], null],
      [
        "BIG",
        "primary",
        ["ITEM_CD", "WH_CD"],
        "2 行を超えるので撮りませんでした。表に条件を付けて、行を絞ってください",
      ],
      ["NONE", "none", [], "テーブル「dbo.NONE」が見つかりません"],
    ]);
  });
});

describe("DiffCameraController", () => {
  function setup() {
    const db: { STOCK: FakeTable; ORDERS: FakeTable } = {
      STOCK: stock(),
      ORDERS: { ...stock(), rows: [] },
    };
    const { session } = fakeDb(db);
    let saved: DiffCamera[] = [];
    const views: ToCameraView[] = [];
    const diffs: DiffView[] = [];
    const messages: string[] = [];
    const copied: string[] = [];
    const excel: { fileName: string; rows: SheetRow[] }[] = [];
    let clock = new Date(2026, 8, 27, 10, 15, 32).getTime();
    const deps = {
      load: () => saved,
      save: async (cameras: DiffCamera[]) => {
        saved = cameras;
      },
      openSession: async () => ({ session, dialect: "mssql" as const }),
      logicalName: (_c: string, t: TableRef) =>
        t.name === "STOCK" ? "在庫" : undefined,
      maxRows: () => 100,
      dialect: () => "mssql" as const,
      askName: vi.fn(async () => "受注登録の確認"),
      chooseConnection: vi.fn(async () => "検証DB"),
      pickTables: vi.fn(async () => [
        { schema: "dbo", name: "STOCK" },
        { schema: "dbo", name: "ORDERS" },
      ]),
      confirmDelete: vi.fn(async () => true),
      postView: (m: ToCameraView) => views.push(m),
      showDiff: (_id: string, view: DiffView) => diffs.push(view),
      copyText: async (t: string) => {
        copied.push(t);
      },
      saveExcel: async (fileName: string, rows: SheetRow[]) => {
        excel.push({ fileName, rows });
      },
      showMessage: (m: string) => messages.push(m),
      newId: () => "cam1",
      now: () => clock,
    };
    const controller = new DiffCameraController(deps);
    const state = (): CameraItem | undefined =>
      views.findLast((v) => v.type === "state")?.cameras[0];
    return {
      controller,
      db,
      deps,
      views,
      diffs,
      messages,
      copied,
      excel,
      state,
      saved: () => saved,
      /** 時計を進める（秒） */
      tick: (seconds: number) => {
        clock += seconds * 1000;
      },
    };
  }

  test("作る → 表を選ぶ → 前を撮る → 変える → 後を撮って比べる → テキストでコピー", async () => {
    const { controller, db, diffs, copied, state, saved } = setup();
    await controller.handle({ type: "create" });
    expect(saved()).toEqual([
      {
        id: "cam1",
        name: "受注登録の確認",
        connection: "検証DB",
        tables: [
          { schema: "dbo", name: "STOCK" },
          { schema: "dbo", name: "ORDERS" },
        ],
      },
    ]);
    expect(state()?.tables[0]).toEqual({
      schema: "dbo",
      name: "STOCK",
      logicalName: "在庫",
    });

    await controller.handle({ type: "takeBefore", id: "cam1" });
    expect(state()?.before).toMatchObject({ rows: 2, tables: 2, errors: 0 });
    db.STOCK.rows = [
      ["A001", "01", "117"],
      ["A002", "01", "40"],
    ];
    db.ORDERS.rows = [["D004", "01", "1"]];
    await controller.handle({ type: "takeAfter", id: "cam1" });

    expect(diffs.at(-1)?.tables.map((t) => [t.name, t.counts])).toEqual([
      ["STOCK", { added: 0, deleted: 0, changed: 1, unchanged: 1 }],
      ["ORDERS", { added: 1, deleted: 0, changed: 0, unchanged: 0 }],
    ]);
    expect(diffs.at(-1)?.tables[0]?.rows).toEqual([
      {
        kind: "changed",
        before: ["A001", "01", "120"],
        values: ["A001", "01", "117"],
        changed: [2],
      },
    ]);
    expect(state()?.history).toEqual([
      {
        id: "cam1:1",
        seq: 1,
        beforeAt: new Date(2026, 8, 27, 10, 15, 32).getTime(),
        afterAt: new Date(2026, 8, 27, 10, 15, 32).getTime(),
        summary: "変更 1 行・追加 1 行",
      },
    ]);
    expect(diffs.at(-1)?.tables[0]?.changedColumns).toEqual([2]);

    await controller.handleDiff("cam1", { type: "copyText", entry: "cam1:1" });
    expect(copied[0]?.split("\n").slice(0, 4)).toEqual([
      "差分カメラ「受注登録の確認」（検証DB）　前 10:15:32 → 後 10:15:32",
      "",
      "在庫 STOCK　変更 1 行",
      "✎ 品目コード=A001・倉庫=01　在庫数 120 → 117",
    ]);
  });

  test("前を撮らずに後を撮ると案内する。表や条件を変えたら、前は捨てる", async () => {
    const { controller, messages, state } = setup();
    await controller.handle({ type: "create" });
    await controller.handle({ type: "takeAfter", id: "cam1" });
    expect(messages.at(-1)).toBe(
      "先に「前を撮る」を押してから、画面を操作してください",
    );
    await controller.handle({ type: "takeBefore", id: "cam1" });
    await controller.handle({
      type: "setCondition",
      id: "cam1",
      index: 0,
      where: "  WH_CD = '01'  ",
    });
    expect(state()?.tables[0]?.where).toBe("WH_CD = '01'");
    expect(state()?.before).toBeNull();
    expect(messages.at(-1)).toContain("「前」を撮り直してください");
  });

  test("条件：おかしな条件は入れない。空にすると外す。列の候補を送る", async () => {
    const { controller, messages, state, views } = setup();
    await controller.handle({ type: "create" });
    await controller.handle({
      type: "setCondition",
      id: "cam1",
      index: 0,
      where: "WH_CD = @wh",
    });
    expect(state()?.tables[0]?.where).toBeUndefined();
    expect(messages.at(-1)).toContain("バインド変数");
    await controller.handle({
      type: "setCondition",
      id: "cam1",
      index: 0,
      where: "WH_CD = '01'",
    });
    await controller.handle({
      type: "setCondition",
      id: "cam1",
      index: 0,
      where: " ",
    });
    expect(state()?.tables[0]?.where).toBeUndefined();

    await controller.handle({ type: "loadColumns", id: "cam1", index: 0 });
    expect(views.at(-1)).toEqual({
      type: "columns",
      id: "cam1",
      index: 0,
      columns: [
        {
          name: "ITEM_CD",
          logicalName: "品目コード",
          typeLabel: "文字 10",
          key: "primary",
        },
        {
          name: "WH_CD",
          logicalName: "倉庫",
          typeLabel: "文字 10",
          key: "primary",
        },
        { name: "QTY", logicalName: "在庫数", typeLabel: "文字 10" },
      ],
    });
  });

  test("比べた記録：回ごとに覚え、前の回も開ける。表や条件を変えても消えない。Excel は全部の行", async () => {
    const { controller, db, diffs, excel, state, tick } = setup();
    await controller.handle({ type: "create" });
    await controller.handle({ type: "takeBefore", id: "cam1" });
    tick(60);
    db.STOCK.rows = [
      ["A001", "01", "117"],
      ["A002", "01", "40"],
    ];
    await controller.handle({ type: "takeAfter", id: "cam1" });
    tick(60);
    db.STOCK.rows = [["A001", "01", "117"]];
    await controller.handle({ type: "takeAfter", id: "cam1" });

    expect(state()?.history.map((h) => [h.id, h.seq, h.summary])).toEqual([
      ["cam1:2", 2, "変更 1 行・削除 1 行"],
      ["cam1:1", 1, "変更 1 行"],
    ]);
    expect(diffs.at(-1)?.entry).toBe("cam1:2");
    expect(diffs.at(-1)?.history).toHaveLength(2);

    await controller.handleDiff("cam1", { type: "show", entry: "cam1:1" });
    expect(diffs.at(-1)?.entry).toBe("cam1:1");
    expect(diffs.at(-1)?.tables[0]?.counts.changed).toBe(1);
    // タブを作り直したとき（ready）は、出していた回
    await controller.handleDiff("cam1", { type: "ready" });
    expect(diffs.at(-1)?.entry).toBe("cam1:1");

    await controller.handle({ type: "removeTable", id: "cam1", index: 1 });
    expect(state()?.before).toBeNull();
    expect(state()?.history).toHaveLength(2);
    await controller.handle({ type: "openDiff", id: "cam1" });
    expect(diffs.at(-1)?.entry).toBe("cam1:2");

    await controller.handleDiff("cam1", {
      type: "saveExcel",
      entry: "cam1:2",
      changedOnly: true,
    });
    expect(excel[0]?.fileName).toBe("差分_受注登録の確認_20260927_101732.xlsx");
    expect(
      excel[0]?.rows.filter((r) => r.kind !== "blank").map((r) => r.cells),
    ).toEqual([
      ["差分カメラ「受注登録の確認」（検証DB）"],
      ["前 2026/09/27 10:15:32 → 後 2026/09/27 10:17:32"],
      ["在庫 STOCK　変更 1 行・削除 1 行（キー：品目コード・倉庫）"],
      ["区分", "ITEM_CD", "WH_CD", "QTY"],
      ["", "品目コード", "倉庫", "在庫数"],
      ["変更前", "A001", "01", "120"],
      ["変更後", "A001", "01", "117"],
      ["削除", "A002", "01", "40"],
      ["ORDERS　変化なし（0 行）"],
    ]);
  });
});
