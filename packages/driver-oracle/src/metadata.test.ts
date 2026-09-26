import { describe, expect, test } from "vitest";
import { type TabColumn, toColumnType } from "./metadata";

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
