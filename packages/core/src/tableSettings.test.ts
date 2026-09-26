import { describe, expect, test } from "vitest";
import type { ColumnInfo } from "./schema";
import {
  applyTableSettings,
  sanitizeTableSettings,
  ymdCandidates,
} from "./tableSettings";

const str = (name: string, length: number | null): ColumnInfo => ({
  name,
  type: { kind: "string", unicode: true, fixedLength: false, length },
});

// 例の列名は架空
const columns: ColumnInfo[] = [
  str("受注番号", 10),
  str("受注日", 8),
  str("得意先コード", 8),
  str("SHIP_YMD", 8),
  str("UPD_DT", 14),
  { name: "数量", type: { kind: "number", precision: 10, scale: 0 } },
  { name: "出荷日", type: { kind: "datetime", hasTime: false } },
];

describe("ymdCandidates", () => {
  test("長さ 8 の文字列で、名前が日付らしい列", () => {
    expect(ymdCandidates(columns)).toEqual(["受注日", "SHIP_YMD"]);
  });

  test("意味型を設定済みの列は除く", () => {
    const set = applyTableSettings(columns, [], {
      semantic: { 受注日: { kind: "date", format: "yyyymmdd" } },
    });
    expect(ymdCandidates(set)).toEqual(["SHIP_YMD"]);
  });
});

describe("applyTableSettings", () => {
  test("意味型は文字列の列だけに当てる。テーブルにない列の設定は無視する", () => {
    const applied = applyTableSettings(columns, ["受注番号"], {
      semantic: {
        受注日: { kind: "date", format: "yyyymmdd" },
        数量: { kind: "date", format: "yyyymmdd" },
        消した列: { kind: "date", format: "yyyymmdd" },
      },
    });
    expect(applied.filter((c) => c.semantic).map((c) => c.name)).toEqual([
      "受注日",
    ]);
    expect(applied).toHaveLength(columns.length);
  });

  test("キーは主キーがあれば主キー。なければ指定したキー", () => {
    const keys = (primaryKey: string[], keyColumns?: string[]) =>
      applyTableSettings(columns, primaryKey, keyColumns ? { keyColumns } : {})
        .filter((c) => c.isKey)
        .map((c) => c.name);
    expect(keys(["受注番号"], ["得意先コード"])).toEqual(["受注番号"]);
    expect(keys([], ["得意先コード", "受注日"])).toEqual([
      "受注日",
      "得意先コード",
    ]);
    expect(keys([])).toEqual([]);
  });
});

describe("sanitizeTableSettings", () => {
  test("形の違う値は捨てる", () => {
    expect(
      sanitizeTableSettings({
        semantic: {
          a: { kind: "date", format: "yyyymmdd" },
          b: { kind: "date", format: "yyyy/mm/dd" },
          c: "date",
        },
        keyColumns: ["x", "", 1, "x", "y"],
        suggestionDismissed: "yes",
      }),
    ).toEqual({
      semantic: { a: { kind: "date", format: "yyyymmdd" } },
      keyColumns: ["x", "y"],
    });
    expect(sanitizeTableSettings(null)).toEqual({});
    expect(sanitizeTableSettings({ suggestionDismissed: true })).toEqual({
      suggestionDismissed: true,
    });
  });
});
