// デモ接続の架空のデータ。社内のテーブルとは関係ない。毎回同じデータになるよう、乱数の種を固定する

import type { ColumnInfo } from "@sql-editor-tool/core";
import type { CellValue, DbObject } from "../session";

export type DemoTable = DbObject & {
  schema: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  rows(): CellValue[][];
};

const varchar = (length: number, unicode = false): ColumnInfo["type"] => ({
  kind: "string",
  unicode,
  fixedLength: false,
  length,
});
const char = (length: number): ColumnInfo["type"] => ({
  kind: "string",
  unicode: false,
  fixedLength: true,
  length,
});
const number = (precision: number, scale = 0): ColumnInfo["type"] => ({
  kind: "number",
  precision,
  scale,
});
const datetime: ColumnInfo["type"] = { kind: "datetime", hasTime: true };

/** 線形合同法。Math.random と違い、種を固定できる */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function ymd(base: Date, offsetDays: number): string {
  const d = new Date(base.getTime() + offsetDays * 86400000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;
}

function timestamp(base: Date, offsetMinutes: number): string {
  const d = new Date(base.getTime() + offsetMinutes * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:00`;
}

const CUSTOMER_NAMES = [
  "山田商店",
  "佐藤工業",
  "鈴木物産",
  "高橋製作所",
  "田中運輸",
  "伊藤食品",
  "渡辺電機",
  "中村建材",
  "小林化成",
  "加藤精機",
];
const PREFS = ["東京都", "大阪府", "愛知県", "福岡県", "北海道", "宮城県"];
const CATEGORIES = ["部品", "消耗品", "工具", "原材料"];
const STATUSES = ["10", "20", "30", "90"];
const NOTES = ["至急", "分納可", "要連絡", "午前着指定", "ｶﾅ備考"];

const BASE_DATE = new Date(Date.UTC(2026, 0, 5));

function customers(): CellValue[][] {
  const rand = random(1);
  return Array.from({ length: 120 }, (_, i) => [
    `C${pad(i + 1, 5)}`,
    `${CUSTOMER_NAMES[i % CUSTOMER_NAMES.length]}${i >= CUSTOMER_NAMES.length ? ` ${Math.floor(i / CUSTOMER_NAMES.length) + 1}号店` : ""}`,
    PREFS[Math.floor(rand() * PREFS.length)] ?? null,
    ymd(BASE_DATE, -Math.floor(rand() * 2000)),
  ]);
}

function items(): CellValue[][] {
  const rand = random(2);
  return Array.from({ length: 300 }, (_, i) => [
    `I${pad(i + 1, 6)}`,
    `品目 ${pad(i + 1, 3)}`,
    CATEGORIES[i % CATEGORIES.length] ?? null,
    Math.round(rand() * 50000) / 100,
  ]);
}

function orders(): CellValue[][] {
  const rand = random(3);
  const rows: CellValue[][] = [];
  for (let order = 1; rows.length < 20000; order += 1) {
    const orderNo = `D${pad(order, 8)}`;
    const day = Math.floor(rand() * 270);
    const cust = `C${pad(Math.floor(rand() * 120) + 1, 5)}`;
    const lines = Math.floor(rand() * 4) + 1;
    for (let line = 1; line <= lines; line += 1) {
      const shipped = rand();
      rows.push([
        orderNo,
        line,
        cust,
        `I${pad(Math.floor(rand() * 300) + 1, 6)}`,
        Math.floor(rand() * 100) + 1,
        Math.round(rand() * 50000) / 100,
        ymd(BASE_DATE, day),
        // 未出荷は、空文字の場合と NULL の場合がある
        shipped < 0.15
          ? null
          : shipped < 0.25
            ? "        "
            : ymd(BASE_DATE, day + 3),
        STATUSES[Math.floor(rand() * STATUSES.length)] ?? null,
        rand() < 0.8
          ? null
          : (NOTES[Math.floor(rand() * NOTES.length)] ?? null),
        timestamp(BASE_DATE, day * 1440 + Math.floor(rand() * 1440)),
      ]);
    }
  }
  return rows;
}

function cached(make: () => CellValue[][]): () => CellValue[][] {
  let rows: CellValue[][] | null = null;
  return () => {
    rows ??= make();
    return rows;
  };
}

const ordersRows = cached(orders);

export const DEMO_TABLES: DemoTable[] = [
  {
    schema: "APP",
    name: "ORDERS",
    kind: "table",
    primaryKey: ["ORDER_NO", "LINE_NO"],
    columns: [
      { name: "ORDER_NO", type: varchar(10) },
      { name: "LINE_NO", type: number(4) },
      { name: "CUST_CD", type: char(6) },
      { name: "ITEM_CD", type: varchar(8) },
      { name: "QTY", type: number(10) },
      { name: "UNIT_PRICE", type: number(12, 2) },
      { name: "ORDER_YMD", type: varchar(8) },
      { name: "SHIP_YMD", type: char(8) },
      { name: "STATUS", type: varchar(2) },
      { name: "NOTE", type: varchar(100, true) },
      { name: "UPDATED_AT", type: datetime },
    ],
    rows: ordersRows,
  },
  {
    schema: "APP",
    name: "CUSTOMERS",
    kind: "table",
    primaryKey: ["CUST_CD"],
    columns: [
      { name: "CUST_CD", type: char(6) },
      { name: "CUST_NAME", type: varchar(40, true) },
      { name: "PREF", type: varchar(10, true) },
      { name: "CREATED_YMD", type: varchar(8) },
    ],
    rows: cached(customers),
  },
  {
    schema: "APP",
    name: "ITEMS",
    kind: "table",
    primaryKey: ["ITEM_CD"],
    columns: [
      { name: "ITEM_CD", type: varchar(8) },
      { name: "ITEM_NAME", type: varchar(40, true) },
      { name: "CATEGORY", type: varchar(20, true) },
      { name: "STD_PRICE", type: number(12, 2) },
    ],
    rows: cached(items),
  },
  {
    schema: "APP",
    name: "V_OPEN_ORDERS",
    kind: "view",
    // ビューには主キーがない
    primaryKey: [],
    columns: [
      { name: "ORDER_NO", type: varchar(10) },
      { name: "CUST_CD", type: char(6) },
      { name: "ORDER_YMD", type: varchar(8) },
      { name: "STATUS", type: varchar(2) },
    ],
    rows: cached(() =>
      ordersRows()
        .filter((row) => row[1] === 1 && row[8] !== "90")
        .map((row) => [
          row[0] ?? null,
          row[2] ?? null,
          row[6] ?? null,
          row[8] ?? null,
        ]),
    ),
  },
];
