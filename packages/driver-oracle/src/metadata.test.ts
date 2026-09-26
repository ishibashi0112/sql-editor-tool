import { describe, expect, test } from "vitest";
import { resultColumnType, type TabColumn, toColumnType } from "./metadata";

const col = (dataType: string, over: Partial<TabColumn> = {}): TabColumn => ({
  dataType,
  dataLength: 0,
  charLength: 0,
  charUsed: null,
  precision: null,
  scale: null,
  ...over,
});

describe("toColumnType", () => {
  test("VARCHAR2 / CHAR の長さは宣言の単位（BYTE ならバイト数）", () => {
    expect(
      toColumnType(
        col("VARCHAR2", { dataLength: 20, charLength: 20, charUsed: "B" }),
      ),
    ).toEqual({
      kind: "string",
      unicode: false,
      fixedLength: false,
      length: 20,
    });
    expect(
      toColumnType(
        col("CHAR", { dataLength: 30, charLength: 10, charUsed: "C" }),
      ),
    ).toEqual({
      kind: "string",
      unicode: false,
      fixedLength: true,
      length: 10,
    });
  });

  test("NVARCHAR2 / NCHAR は文字数", () => {
    expect(
      toColumnType(
        col("NVARCHAR2", { dataLength: 40, charLength: 20, charUsed: "C" }),
      ),
    ).toEqual({
      kind: "string",
      unicode: true,
      fixedLength: false,
      length: 20,
    });
  });

  test("NUMBER は精度と位取り。指定がなければ null", () => {
    expect(toColumnType(col("NUMBER", { precision: 10, scale: 2 }))).toEqual({
      kind: "number",
      precision: 10,
      scale: 2,
    });
    expect(toColumnType(col("NUMBER"))).toEqual({
      kind: "number",
      precision: null,
      scale: null,
    });
    expect(toColumnType(col("BINARY_DOUBLE"))).toEqual({
      kind: "number",
      precision: null,
      scale: null,
    });
  });

  test("DATE と TIMESTAMP は時刻あり", () => {
    for (const name of ["DATE", "TIMESTAMP(6)"]) {
      expect(toColumnType(col(name))).toEqual({
        kind: "datetime",
        hasTime: true,
      });
    }
  });

  test("条件で扱わない型は other", () => {
    for (const name of [
      "CLOB",
      "BLOB",
      "RAW",
      "TIMESTAMP(6) WITH TIME ZONE",
      "INTERVAL DAY(2) TO SECOND(6)",
    ]) {
      expect(toColumnType(col(name))).toEqual({
        kind: "other",
        dbTypeName: name,
      });
    }
  });
});

describe("resultColumnType（結果の列の型）", () => {
  test("VARCHAR2 と NVARCHAR2 の長さ", () => {
    expect(resultColumnType({ dbTypeName: "VARCHAR2", byteSize: 20 })).toEqual({
      kind: "string",
      unicode: false,
      fixedLength: false,
      length: 20,
    });
    expect(
      resultColumnType({ dbTypeName: "NVARCHAR2", byteSize: 40 }),
    ).toMatchObject({ unicode: true, length: 20 });
  });

  test("NUMBER の精度の指定がなければ null（precision 0、scale -127 で届く）", () => {
    expect(
      resultColumnType({ dbTypeName: "NUMBER", precision: 0, scale: -127 }),
    ).toEqual({ kind: "number", precision: null, scale: null });
    expect(
      resultColumnType({ dbTypeName: "NUMBER", precision: 10, scale: 2 }),
    ).toEqual({ kind: "number", precision: 10, scale: 2 });
  });

  test("DATE と TIMESTAMP は時刻あり", () => {
    for (const dbTypeName of ["DATE", "TIMESTAMP"]) {
      expect(resultColumnType({ dbTypeName })).toEqual({
        kind: "datetime",
        hasTime: true,
      });
    }
  });
});
