// テスト用の架空のテーブル定義
import type { ColumnInfo } from "./schema";

export const columns: ColumnInfo[] = [
  // VARCHAR(10)
  {
    name: "ORDER_NO",
    type: { kind: "string", unicode: false, fixedLength: false, length: 10 },
  },
  // CHAR(6)
  {
    name: "CUST_CD",
    type: { kind: "string", unicode: false, fixedLength: true, length: 6 },
  },
  // NVARCHAR(40)
  {
    name: "CUST_NAME",
    type: { kind: "string", unicode: true, fixedLength: false, length: 40 },
  },
  { name: "QTY", type: { kind: "number", precision: 10, scale: 0 } },
  // VARCHAR(8) だが中身は yyyymmdd
  {
    name: "ORDER_YMD",
    type: { kind: "string", unicode: false, fixedLength: false, length: 8 },
    semantic: { kind: "date", format: "yyyymmdd" },
  },
  // CHAR(8) の yyyymmdd
  {
    name: "SHIP_YMD",
    type: { kind: "string", unicode: false, fixedLength: true, length: 8 },
    semantic: { kind: "date", format: "yyyymmdd" },
  },
  // datetime / Oracle の DATE
  { name: "UPDATED_AT", type: { kind: "datetime", hasTime: true } },
  // SQL Server の date
  { name: "DUE_DATE", type: { kind: "datetime", hasTime: false } },
  { name: "NOTE", type: { kind: "other", dbTypeName: "CLOB" } },
];
