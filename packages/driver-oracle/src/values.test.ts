import oracledb from "oracledb";
import { describe, expect, test, vi } from "vitest";
import {
  fetchTypeHandler,
  normalizeNumberText,
  toBinds,
  toCellValue,
} from "./values";

const meta = (dbType: oracledb.DbType, precision?: number) => ({
  name: "X",
  dbType,
  ...(precision === undefined ? {} : { precision }),
});

describe("fetchTypeHandler", () => {
  test("精度の指定がない NUMBER と 16 桁以上の NUMBER は文字列で取る", () => {
    expect(fetchTypeHandler(meta(oracledb.DB_TYPE_NUMBER, 0))?.type).toBe(
      oracledb.STRING,
    );
    expect(fetchTypeHandler(meta(oracledb.DB_TYPE_NUMBER, 16))?.type).toBe(
      oracledb.STRING,
    );
    expect(fetchTypeHandler(meta(oracledb.DB_TYPE_NUMBER, 15))).toBeUndefined();
  });

  test("CLOB は文字列、それ以外はそのまま", () => {
    expect(fetchTypeHandler(meta(oracledb.DB_TYPE_CLOB))?.type).toBe(
      oracledb.STRING,
    );
    expect(fetchTypeHandler(meta(oracledb.DB_TYPE_VARCHAR))).toBeUndefined();
    expect(fetchTypeHandler(meta(oracledb.DB_TYPE_DATE))).toBeUndefined();
  });

  test("Thin モードの '.5' の形は先頭に 0 を補う", () => {
    expect(normalizeNumberText(".5")).toBe("0.5");
    expect(normalizeNumberText("-.25")).toBe("-0.25");
    expect(normalizeNumberText("12345678901234567890")).toBe(
      "12345678901234567890",
    );
    expect(normalizeNumberText(null)).toBeNull();
  });
});

describe("toCellValue", () => {
  test("DATE はローカル時刻で読み、時刻を付ける", () => {
    expect(toCellValue(new Date(2026, 8, 1, 0, 0, 0))).toBe(
      "2026-09-01 00:00:00",
    );
    expect(toCellValue(new Date(2026, 8, 1, 13, 5, 9, 120))).toBe(
      "2026-09-01 13:05:09.12",
    );
  });

  test("RAW は 16 進、BLOB は中身を読まずに大きさだけ出してロケーターを解放する", () => {
    expect(toCellValue(Buffer.from([255, 1]))).toBe("0xFF01");
    const lob = { type: oracledb.DB_TYPE_BLOB, length: 2048, destroy: vi.fn() };
    expect(toCellValue(lob)).toBe("（BLOB 2048 バイト）");
    expect(lob.destroy).toHaveBeenCalled();
  });

  test("文字列・数値・NULL はそのまま", () => {
    expect(toCellValue("ｱｲｳ")).toBe("ｱｲｳ");
    expect(toCellValue(3)).toBe(3);
    expect(toCellValue(null)).toBeNull();
  });
});

describe("toBinds", () => {
  test("文字列は列の型に合わせて VARCHAR / NVARCHAR", () => {
    expect(
      toBinds([
        { name: "p1", value: "A", type: { kind: "string", unicode: false } },
        { name: "p2", value: "あ", type: { kind: "string", unicode: true } },
      ]),
    ).toEqual({
      p1: { type: oracledb.DB_TYPE_VARCHAR, val: "A" },
      p2: { type: oracledb.DB_TYPE_NVARCHAR, val: "あ" },
    });
  });

  test("数値は 15 桁以内なら NUMBER、それより多ければ文字列で送る", () => {
    expect(
      toBinds([
        { name: "p1", value: "12.50", type: { kind: "number" } },
        { name: "p2", value: 100001, type: { kind: "integer" } },
        {
          name: "p3",
          value: "12345678901234567890",
          type: { kind: "number" },
        },
      ]),
    ).toEqual({
      p1: { type: oracledb.DB_TYPE_NUMBER, val: 12.5 },
      p2: { type: oracledb.DB_TYPE_NUMBER, val: 100001 },
      p3: { type: oracledb.DB_TYPE_VARCHAR, val: "12345678901234567890" },
    });
  });
});
