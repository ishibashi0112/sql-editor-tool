import { describe, expect, test } from "vitest";
import {
  formatBinary,
  formatDateTime,
  formatTime,
  toPlainDecimal,
} from "./values";

const parts = {
  year: 2026,
  month: 9,
  day: 1,
  hour: 8,
  minute: 5,
  second: 3,
  fraction: 0,
};

describe("formatDateTime", () => {
  test("日付だけ、または時刻つき（0 時でも時刻を付ける）", () => {
    expect(formatDateTime(parts, false)).toBe("2026-09-01");
    expect(formatDateTime(parts, true)).toBe("2026-09-01 08:05:03");
    expect(
      formatDateTime({ ...parts, hour: 0, minute: 0, second: 0 }, true),
    ).toBe("2026-09-01 00:00:00");
  });

  test("秒の小数部は 0 でなければ付け、末尾の 0 は除く", () => {
    expect(formatTime({ ...parts, fraction: 1230000 })).toBe("08:05:03.123");
    expect(formatTime({ ...parts, fraction: 1234567 })).toBe(
      "08:05:03.1234567",
    );
    expect(formatTime({ ...parts, fraction: 1 })).toBe("08:05:03.0000001");
  });

  test("4 桁に満たない年も 0 で埋める", () => {
    expect(formatDateTime({ ...parts, year: 1 }, false)).toBe("0001-09-01");
  });
});

describe("formatBinary", () => {
  test("16 進にする。長いものは先頭だけ", () => {
    expect(formatBinary(new Uint8Array([0, 15, 255]))).toBe("0x000FFF");
    expect(formatBinary(new Uint8Array(100))).toMatch(
      /^0x(00){64}…（100 バイト）$/,
    );
  });
});

describe("toPlainDecimal", () => {
  test("指数表記なしの形と桁数", () => {
    expect(toPlainDecimal(12.5)).toEqual({
      text: "12.5",
      integerDigits: 2,
      scale: 1,
    });
    expect(toPlainDecimal("-0.0500")).toEqual({
      text: "-0.05",
      integerDigits: 0,
      scale: 2,
    });
    expect(toPlainDecimal("007")).toEqual({
      text: "7",
      integerDigits: 1,
      scale: 0,
    });
  });

  test("指数表記を展開する", () => {
    expect(toPlainDecimal(1e21)?.text).toBe("1000000000000000000000");
    expect(toPlainDecimal(1.5e-7)?.text).toBe("0.00000015");
    expect(toPlainDecimal("-1.5E3")?.text).toBe("-1500");
  });

  test("桁の多い文字列はそのまま（数値にしない）", () => {
    expect(toPlainDecimal("12345678901234567890.123400")).toEqual({
      text: "12345678901234567890.1234",
      integerDigits: 20,
      scale: 4,
    });
  });

  test("0 と、小数点で始まる・終わる形", () => {
    expect(toPlainDecimal("-0")?.text).toBe("0");
    expect(toPlainDecimal(".5")?.text).toBe("0.5");
    expect(toPlainDecimal("3.")?.text).toBe("3");
  });

  test("数値でなければ null", () => {
    for (const value of ["", ".", "abc", "1,000", Number.NaN, Infinity]) {
      expect(toPlainDecimal(value)).toBeNull();
    }
  });
});
