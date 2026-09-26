import { describe, expect, test } from "vitest";
import {
  isRelativeDate,
  resolveDateValue,
  resolveRelativeDate,
} from "./relativeDate";

// ローカル時刻の 2026-09-26（土）
const now = new Date(2026, 8, 26, 10, 30);
const at = (text: string, base = now) => resolveRelativeDate(text, base);

describe("resolveRelativeDate", () => {
  test("基準", () => {
    expect(at("今日")).toBe("2026-09-26");
    expect(at("月初")).toBe("2026-09-01");
    expect(at("月末")).toBe("2026-09-30");
    expect(at("年初")).toBe("2026-01-01");
    expect(at("年末")).toBe("2026-12-31");
    expect(at("年度初")).toBe("2026-04-01");
    expect(at("年度末")).toBe("2027-03-31");
  });

  test("年度は 4 月始まり。1〜3 月は前の年の年度", () => {
    const march = new Date(2027, 2, 15);
    expect(at("年度初", march)).toBe("2026-04-01");
    expect(at("年度末", march)).toBe("2027-03-31");
    const april = new Date(2027, 3, 1);
    expect(at("年度初", april)).toBe("2027-04-01");
  });

  test("日・か月・年の増減", () => {
    expect(at("今日-7日")).toBe("2026-09-19");
    expect(at("今日+10日")).toBe("2026-10-06");
    expect(at("月初-1か月")).toBe("2026-08-01");
    expect(at("月末-1か月")).toBe("2026-08-31");
    expect(at("月末+5か月")).toBe("2027-02-28");
    expect(at("月初-9か月")).toBe("2025-12-01");
    expect(at("今日-1年")).toBe("2025-09-26");
    expect(at("年初-1年")).toBe("2025-01-01");
    expect(at("月末+1日")).toBe("2026-10-01");
  });

  test("か月・年を先に当て、そのあと日を当てる（書く順によらない）", () => {
    expect(at("月初-1日-1か月")).toBe("2026-07-31");
    expect(at("月初-1か月-1日")).toBe("2026-07-31");
  });

  test("今日±か月で月末を越えるときは、その月の末日", () => {
    expect(at("今日-1か月", new Date(2026, 2, 31))).toBe("2026-02-28");
    expect(at("今日+11か月", new Date(2027, 2, 31))).toBe("2028-02-29");
  });

  test("別名", () => {
    expect(at("昨日")).toBe("2026-09-25");
    expect(at("明日")).toBe("2026-09-27");
    expect(at("本日")).toBe("2026-09-26");
    expect(at("前月初")).toBe("2026-08-01");
    expect(at("前月末")).toBe("2026-08-31");
    expect(at("翌月初")).toBe("2026-10-01");
    expect(at("翌月末")).toBe("2026-10-31");
    expect(at("今月初")).toBe("2026-09-01");
    expect(at("今月末")).toBe("2026-09-30");
    expect(at("前月末-1日")).toBe("2026-08-30");
  });

  test("か月の書き方の違い、全角、空白", () => {
    for (const unit of ["か月", "ヶ月", "ケ月", "カ月", "ヵ月", "箇月", "月"]) {
      expect(at(`月初-1${unit}`)).toBe("2026-08-01");
    }
    expect(at("今日－７日")).toBe("2026-09-19");
    expect(at("今日−7日")).toBe("2026-09-19");
    expect(at(" 月初 - 1 か月 ")).toBe("2026-08-01");
  });

  test("相対の日付でなければ null", () => {
    for (const text of [
      "",
      "2026-09-01",
      "今日-",
      "今日-7",
      "今日7日",
      "今日-7週",
      "きょう",
      "月初あ",
      "C00027",
    ]) {
      expect(at(text), text).toBeNull();
      expect(isRelativeDate(text), text).toBe(false);
    }
    expect(isRelativeDate("前月末")).toBe(true);
  });
});

describe("resolveDateValue", () => {
  test("日付そのものは、実在すれば 'YYYY-MM-DD' にそろえる", () => {
    expect(resolveDateValue("2026-09-01", now)).toBe("2026-09-01");
    expect(resolveDateValue("2026/9/1", now)).toBe("2026-09-01");
    expect(resolveDateValue("20260901", now)).toBe("2026-09-01");
    expect(resolveDateValue("2026-02-30", now)).toBeNull();
  });

  test("相対の日付も読む。どちらでもなければ null", () => {
    expect(resolveDateValue("月初", now)).toBe("2026-09-01");
    expect(resolveDateValue("あした", now)).toBeNull();
  });
});
