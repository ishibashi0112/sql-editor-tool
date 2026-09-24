import { describe, expect, test } from "vitest";
import { nextDateKey, normalizeDateKey, toYmd, ymdToDateKey } from "./dateKey";

describe("normalizeDateKey", () => {
  test("区切りと桁をそろえる", () => {
    expect(normalizeDateKey("2026-09-23")).toBe("2026-09-23");
    expect(normalizeDateKey("2026/9/3")).toBe("2026-09-03");
    expect(normalizeDateKey(" 2026-09-23 ")).toBe("2026-09-23");
  });

  test("実在しない日付や形式違いは null", () => {
    expect(normalizeDateKey("2026-02-29")).toBe(null);
    expect(normalizeDateKey("2026-13-01")).toBe(null);
    expect(normalizeDateKey("0099-01-01")).toBe(null);
    expect(normalizeDateKey("20260923")).toBe(null);
    expect(normalizeDateKey("2026-09-23 10:00")).toBe(null);
  });

  test("うるう年", () => {
    expect(normalizeDateKey("2028-02-29")).toBe("2028-02-29");
  });
});

describe("nextDateKey", () => {
  test("月末・年末・うるう年をまたぐ", () => {
    expect(nextDateKey("2026-09-30")).toBe("2026-10-01");
    expect(nextDateKey("2026-12-31")).toBe("2027-01-01");
    expect(nextDateKey("2028-02-28")).toBe("2028-02-29");
  });
});

test("toYmd", () => {
  expect(toYmd("2026-09-23")).toBe("20260923");
});

test("ymdToDateKey", () => {
  expect(ymdToDateKey("20260923")).toBe("2026-09-23");
  // CHAR 列の末尾の空白
  expect(ymdToDateKey("20260923  ")).toBe("2026-09-23");
  expect(ymdToDateKey("00000000")).toBe(null);
  expect(ymdToDateKey("20260230")).toBe(null);
  expect(ymdToDateKey("2026-09-23")).toBe(null);
});
