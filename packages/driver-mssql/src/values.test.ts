import { TYPES } from "tedious";
import { describe, expect, test } from "vitest";
import { toCellValue, toTediousParam } from "./values";

/** tedious が useUTC で作る Date（DB の値をそのまま UTC として持つ） */
const utc = (text: string, nanosecondsDelta?: number) => {
  const date = new Date(`${text}Z`);
  if (nanosecondsDelta !== undefined) {
    Object.defineProperty(date, "nanosecondsDelta", {
      value: nanosecondsDelta,
    });
  }
  return date;
};

describe("toCellValue", () => {
  test("文字列・数値・NULL はそのまま、bit は 0 / 1", () => {
    expect(toCellValue("あいう", "NVarChar")).toBe("あいう");
    expect(toCellValue(12.5, "DecimalN")).toBe(12.5);
    expect(toCellValue(null, "Int")).toBeNull();
    expect(toCellValue(true, "Bit")).toBe(1);
    expect(toCellValue(false, "BitN")).toBe(0);
  });

  test("日付は UTC で読み、型に合わせた書式にする", () => {
    expect(toCellValue(utc("2026-09-01T00:00:00"), "Date")).toBe("2026-09-01");
    expect(toCellValue(utc("2026-09-01T00:00:00"), "DateTimeN")).toBe(
      "2026-09-01 00:00:00",
    );
    expect(toCellValue(utc("2026-09-01T12:34:56.123"), "DateTime")).toBe(
      "2026-09-01 12:34:56.123",
    );
  });

  test("datetime2 / time はミリ秒より下の桁も出す", () => {
    expect(
      toCellValue(utc("2026-09-01T12:34:56.123", 0.0004567), "DateTime2"),
    ).toBe("2026-09-01 12:34:56.1234567");
    expect(toCellValue(utc("1970-01-01T08:30:00", 0), "Time")).toBe("08:30:00");
  });

  test("バイナリは 16 進", () => {
    expect(toCellValue(Buffer.from([1, 171]), "VarBinary")).toBe("0x01AB");
  });
});

describe("toTediousParam", () => {
  test("文字列は列の型に合わせて varchar / nvarchar", () => {
    expect(
      toTediousParam({
        name: "p1",
        value: "A",
        type: { kind: "string", unicode: false },
      }),
    ).toEqual({ name: "p1", type: TYPES.VarChar, value: "A" });
    expect(
      toTediousParam({
        name: "p1",
        value: "あ",
        type: { kind: "string", unicode: true },
      }).type,
    ).toBe(TYPES.NVarChar);
  });

  test("整数は int、int に収まらなければ bigint（文字列のまま）", () => {
    expect(
      toTediousParam({ name: "p1", value: 100001, type: { kind: "integer" } }),
    ).toEqual({ name: "p1", type: TYPES.Int, value: 100001 });
    expect(
      toTediousParam({
        name: "p1",
        value: "1234567890123456789",
        type: { kind: "number" },
      }),
    ).toEqual({ name: "p1", type: TYPES.BigInt, value: "1234567890123456789" });
  });

  test("小数は桁に合わせた decimal(p, s)", () => {
    expect(
      toTediousParam({ name: "p1", value: "-0.050", type: { kind: "number" } }),
    ).toEqual({
      name: "p1",
      type: TYPES.Decimal,
      value: -0.05,
      options: { precision: 2, scale: 2 },
    });
    expect(
      toTediousParam({ name: "p1", value: 1234.5, type: { kind: "number" } })
        .options,
    ).toEqual({ precision: 5, scale: 1 });
  });

  test("15 桁を超える小数と bigint を超える整数は、桁を落とさないよう varchar で送る", () => {
    expect(
      toTediousParam({
        name: "p1",
        value: "12345678901234.56789",
        type: { kind: "number" },
      }),
    ).toEqual({
      name: "p1",
      type: TYPES.VarChar,
      value: "12345678901234.56789",
    });
    expect(
      toTediousParam({
        name: "p1",
        value: "99999999999999999999",
        type: { kind: "number" },
      }).type,
    ).toBe(TYPES.VarChar);
  });

  test("数値でない値はエラー", () => {
    expect(() =>
      toTediousParam({ name: "p1", value: "abc", type: { kind: "number" } }),
    ).toThrow("数値ではありません");
  });
});
