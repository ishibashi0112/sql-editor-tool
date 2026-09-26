import { describe, expect, test } from "vitest";
import {
  paramGuessOf,
  resultColumnType,
  type SysColumn,
  toColumnType,
} from "./metadata";

const col = (
  typeName: string,
  maxLength: number,
  precision = 0,
  scale = 0,
): SysColumn => ({ typeName, maxLength, precision, scale });

describe("toColumnType", () => {
  test("文字列：nvarchar / nchar の長さはバイト数の半分。MAX は null", () => {
    expect(toColumnType(col("nvarchar", 80))).toEqual({
      kind: "string",
      unicode: true,
      fixedLength: false,
      length: 40,
    });
    expect(toColumnType(col("nchar", 16))).toMatchObject({
      fixedLength: true,
      length: 8,
    });
    expect(toColumnType(col("varchar", -1))).toEqual({
      kind: "string",
      unicode: false,
      fixedLength: false,
      length: null,
    });
    expect(toColumnType(col("CHAR", 8))).toMatchObject({
      unicode: false,
      fixedLength: true,
      length: 8,
    });
  });

  test("decimal / numeric は 16 桁以上だけ文字列で取る（asText）", () => {
    expect(toColumnType(col("numeric", 9, 15, 4))).toEqual({
      kind: "number",
      precision: 15,
      scale: 4,
    });
    expect(toColumnType(col("decimal", 9, 19, 0))).toEqual({
      kind: "number",
      precision: 19,
      scale: 0,
      asText: true,
    });
  });

  test("整数・bit・浮動小数点", () => {
    expect(toColumnType(col("int", 4, 10, 0))).toEqual({
      kind: "number",
      precision: 10,
      scale: 0,
    });
    // bigint は tedious が文字列で返すので、変換しない
    expect(toColumnType(col("bigint", 8, 19, 0))).not.toHaveProperty("asText");
    expect(toColumnType(col("bit", 1, 1, 0))).toEqual({
      kind: "number",
      precision: 1,
      scale: 0,
    });
    expect(toColumnType(col("float", 8, 53, 0))).toEqual({
      kind: "number",
      precision: null,
      scale: null,
    });
  });

  test("日付：date は時刻なし、datetime / datetime2 / smalldatetime は時刻あり", () => {
    expect(toColumnType(col("date", 3, 10, 0))).toEqual({
      kind: "datetime",
      hasTime: false,
    });
    for (const name of ["datetime", "datetime2", "smalldatetime"]) {
      expect(toColumnType(col(name, 8))).toEqual({
        kind: "datetime",
        hasTime: true,
      });
    }
  });

  test("条件で扱わない型は other", () => {
    for (const name of [
      "text",
      "ntext",
      "time",
      "datetimeoffset",
      "uniqueidentifier",
      "varbinary",
      "xml",
    ]) {
      expect(toColumnType(col(name, 16))).toEqual({
        kind: "other",
        dbTypeName: name,
      });
    }
  });
});

describe("resultColumnType（結果の列の型）", () => {
  test("文字列の長さ。nvarchar はバイト数の半分、MAX は null", () => {
    expect(
      resultColumnType({ type: { name: "NVarChar" }, dataLength: 40 }),
    ).toEqual({
      kind: "string",
      unicode: true,
      fixedLength: false,
      length: 20,
    });
    expect(
      resultColumnType({ type: { name: "VarChar" }, dataLength: 65535 }),
    ).toMatchObject({ length: null });
  });

  test("数値・日付・bit", () => {
    expect(resultColumnType({ type: { name: "IntN" }, dataLength: 8 })).toEqual(
      {
        kind: "number",
        precision: 19,
        scale: 0,
      },
    );
    expect(
      resultColumnType({ type: { name: "DecimalN" }, precision: 19, scale: 2 }),
    ).toEqual({ kind: "number", precision: 19, scale: 2 });
    expect(resultColumnType({ type: { name: "Date" } })).toEqual({
      kind: "datetime",
      hasTime: false,
    });
    expect(resultColumnType({ type: { name: "DateTimeN" } })).toEqual({
      kind: "datetime",
      hasTime: true,
    });
    expect(resultColumnType({ type: { name: "BitN" } })).toEqual({
      kind: "number",
      precision: 1,
      scale: 0,
    });
  });

  test("条件で扱わない型は other", () => {
    expect(resultColumnType({ type: { name: "UniqueIdentifier" } })).toEqual({
      kind: "other",
      dbTypeName: "uniqueidentifier",
    });
  });
});

describe("paramGuessOf（sp_describe_undeclared_parameters の型）", () => {
  test("文字列の長さは文字数。MAX は null", () => {
    expect(paramGuessOf("nvarchar(8)", 16)).toEqual({
      kind: "string",
      length: 8,
    });
    expect(paramGuessOf("varchar(6)", 6)).toEqual({
      kind: "string",
      length: 6,
    });
    expect(paramGuessOf("nvarchar(max)", -1)).toEqual({
      kind: "string",
      length: null,
    });
    expect(paramGuessOf("char(1)", 1)).toEqual({ kind: "string", length: 1 });
  });

  test("数値・日付・それ以外", () => {
    for (const t of ["int", "decimal(38,19)", "bit", "float", "money"]) {
      expect(paramGuessOf(t, 8), t).toEqual({ kind: "number" });
    }
    for (const t of ["date", "datetime", "datetime2(7)", "smalldatetime"]) {
      expect(paramGuessOf(t, 8), t).toEqual({ kind: "date" });
    }
    for (const t of ["uniqueidentifier", "time(7)", "varbinary(max)", "xml"]) {
      expect(paramGuessOf(t, 16), t).toEqual({ kind: "other" });
    }
  });
});
