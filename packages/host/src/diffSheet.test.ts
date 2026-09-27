import { describe, expect, test } from "vitest";
import type { DiffTableView, DiffView } from "./diffCameraProtocol";
import { diffSheet, sheetHtml, sheetTsv, shownColumns } from "./diffSheet";

// 架空の表
const orders: DiffTableView = {
  schema: "dbo",
  name: "ORDERS",
  logicalName: "受注",
  where: "ORDER_YMD >= '20260901'",
  columns: [
    { name: "ORDER_NO", logicalName: "受注番号", key: true },
    { name: "CUST_CD", logicalName: "得意先", key: false },
    { name: "QTY", logicalName: "数量", key: false },
    { name: "NOTE", key: false },
  ],
  changedColumns: [2],
  keySource: "primary",
  counts: { added: 1, deleted: 1, changed: 1, unchanged: 3 },
  rows: [
    {
      kind: "changed",
      before: ["D001", "C01", 5, null],
      values: ["D001", "C01", 99, null],
      changed: [2],
    },
    { kind: "added", values: ["D005", "00123", 1, "a\tb\n<c>"] },
    { kind: "deleted", values: ["D002", "C02", 3, ""] },
  ],
  more: 0,
  columnsChanged: false,
};

const view = (tables: DiffTableView[]): DiffView => ({
  camera: "受注登録の確認",
  connection: "検証DB",
  entry: "cam1:1",
  history: [],
  beforeAt: new Date(2026, 8, 27, 10, 3, 12).getTime(),
  afterAt: new Date(2026, 8, 27, 10, 5, 40).getTime(),
  tables,
});

describe("shownColumns", () => {
  test("変わった列だけなら、キーと変わった列。変わった行がなければ全部", () => {
    expect(shownColumns(orders, true)).toEqual([0, 2]);
    expect(shownColumns(orders, false)).toEqual([0, 1, 2, 3]);
    expect(shownColumns({ ...orders, changedColumns: [] }, true)).toEqual([
      0, 1, 2, 3,
    ]);
  });
});

describe("diffSheet", () => {
  test("変わった行は変更前と変更後の 2 行。追加・削除は 1 行。論理名は見出しの 2 行目", () => {
    const rows = diffSheet(view([orders]), { changedOnly: false });
    expect(rows.map((r) => [r.kind, r.cells])).toEqual([
      ["title", ["差分カメラ「受注登録の確認」（検証DB）"]],
      ["meta", ["前 2026/09/27 10:03:12 → 後 2026/09/27 10:05:40"]],
      ["blank", []],
      [
        "table",
        ["受注 ORDERS　変更 1 行・追加 1 行・削除 1 行（キー：受注番号）"],
      ],
      ["note", ["条件：ORDER_YMD >= '20260901'"]],
      ["header", ["区分", "ORDER_NO", "CUST_CD", "QTY", "NOTE"]],
      ["headerLogical", ["", "受注番号", "得意先", "数量", ""]],
      ["before", ["変更前", "D001", "C01", 5, null]],
      ["after", ["変更後", "D001", "C01", 99, null]],
      ["added", ["追加", "D005", "00123", 1, "a\tb\n<c>"]],
      ["deleted", ["削除", "D002", "C02", 3, ""]],
    ]);
    expect(rows.find((r) => r.kind === "after")?.changed).toEqual([3]);
    expect(rows.find((r) => r.kind === "header")?.keys).toEqual([1]);
  });

  test("変わった列だけ。撮れなかった表・キーのない表・出していない行の断り", () => {
    const { where: _where, ...noWhere } = orders;
    const { logicalName: _logical, ...plain } = noWhere;
    const rows = diffSheet(
      view([
        { ...noWhere, more: 2 },
        {
          ...plain,
          name: "WORK",
          keySource: "none",
          columns: orders.columns.map((c) => ({ ...c, key: false })),
          changedColumns: [],
          counts: { added: 1, deleted: 0, changed: 0, unchanged: 0 },
          rows: [{ kind: "added", values: ["X", "Y", 1, null] }],
        },
        {
          ...plain,
          where: "ORDER_YMD >= '20260901'",
          name: "BIG",
          error: "後：10 行を超えるので撮りませんでした",
        },
      ]),
      { changedOnly: true },
    );
    const texts = rows
      .filter((r) => r.kind !== "blank")
      .map((r) => r.cells.join("|"));
    expect(texts.slice(2)).toEqual([
      "受注 ORDERS　変更 1 行・追加 1 行・削除 1 行（キー：受注番号）",
      "区分|ORDER_NO|QTY",
      "|受注番号|数量",
      "変更前|D001|5",
      "変更後|D001|99",
      "追加|D005|1",
      "削除|D002|3",
      "ほかに 2 行あります（「Excel で保存」で全部出せます）",
      "WORK　追加 1 行",
      "主キーもキーの設定もないので、中身が変わった行は削除と追加で出しています",
      "区分|ORDER_NO|CUST_CD|QTY|NOTE",
      "|受注番号|得意先|数量|",
      "追加|X|Y|1|",
      "BIG",
      "条件：ORDER_YMD >= '20260901'",
      "撮れませんでした：後：10 行を超えるので撮りませんでした",
    ]);
  });
});

describe("sheetTsv と sheetHtml", () => {
  const rows = diffSheet(view([orders]), { changedOnly: false });

  test("タブ区切り：NULL は「NULL」、タブや改行を含む値は引用符で囲む", () => {
    const lines = sheetTsv(rows).split("\r\n");
    expect(lines[7]).toBe("変更前\tD001\tC01\t5\tNULL");
    expect(sheetTsv(rows)).toContain('追加\tD005\t00123\t1\t"a\tb\n<c>"');
  });

  test("HTML：文字は文字のまま貼る（00123 を数値にしない）、色、エスケープ、セルの中の改行", () => {
    const html = sheetHtml(rows);
    expect(html).toContain(
      `<td style="border:.5pt solid #D9D9D9;background:#E2EFDA;mso-number-format:'\\@'">00123</td>`,
    );
    // 変わったセル（変更後）は黄色で太字、数値はそのまま
    expect(html).toContain(
      '<td style="border:.5pt solid #D9D9D9;background:#FFF2CC;font-weight:bold">99</td>',
    );
    expect(html).toContain(
      'a\tb<br style="mso-data-placement:same-cell">&lt;c&gt;',
    );
    expect(html).toContain(">NULL</td>");
    expect(html.startsWith('<meta charset="utf-8"><table')).toBe(true);
  });
});
