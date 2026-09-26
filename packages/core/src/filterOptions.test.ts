import { describe, expect, test } from "vitest";
import type { ColumnFilterValue } from "./filter";
import { buildFilterOptionsQuery, toFilterOptions } from "./filterOptions";
import type { ColumnInfo } from "./schema";
import { buildWhere } from "./select";
import { columns } from "./testColumns";

const source = {
  kind: "table",
  table: { schema: "APP", name: "ORDERS" },
} as const;

function column(name: string): ColumnInfo {
  const found = columns.find((c) => c.name === name);
  if (!found) throw new Error(name);
  return found;
}

const filters: Record<string, ColumnFilterValue> = {
  // 候補を取る列自身の条件は使わない
  CUST_CD: { kind: "set", values: ["X"] },
  QTY: {
    kind: "number",
    raw: "",
    parsed: { mode: "comparison", operator: ">", value: 0 },
  },
};

describe("buildFilterOptionsQuery", () => {
  test("SQL Server：ほかの列の条件で絞り、上限 + 1 件を TOP で取る", () => {
    const q = buildFilterOptionsQuery({
      dialect: "mssql",
      source,
      columns,
      columnKey: "CUST_CD",
      filters,
      limit: 10000,
    });
    expect(q.sql).toBe(
      [
        "SELECT DISTINCT TOP (@p1) [CUST_CD] AS [OPTION_VALUE]",
        "FROM [APP].[ORDERS]",
        "WHERE [QTY] > @p2",
        "ORDER BY [OPTION_VALUE]",
      ].join("\n"),
    );
    expect(q.params).toEqual([
      { name: "p1", value: 10001, type: { kind: "integer" } },
      { name: "p2", value: 0, type: { kind: "number" } },
    ]);
  });

  test("Oracle：空欄を先頭にして、FETCH FIRST で取る", () => {
    const q = buildFilterOptionsQuery({
      dialect: "oracle",
      source,
      columns,
      columnKey: "CUST_CD",
      filters,
      limit: 10000,
    });
    expect(q.sql).toBe(
      [
        'SELECT DISTINCT "CUST_CD" AS "OPTION_VALUE"',
        'FROM "APP"."ORDERS"',
        'WHERE "QTY" > :p1',
        'ORDER BY "OPTION_VALUE" NULLS FIRST',
        "FETCH FIRST :p2 ROWS ONLY",
      ].join("\n"),
    );
    expect(q.literalSql.split("\n").at(-1)).toBe("FETCH FIRST 10001 ROWS ONLY");
  });

  test("条件がなければ WHERE を付けない", () => {
    const q = buildFilterOptionsQuery({
      dialect: "mssql",
      source,
      columns,
      columnKey: "QTY",
      limit: 10,
    });
    expect(q.sql).toBe(
      [
        "SELECT DISTINCT TOP (@p1) [QTY] AS [OPTION_VALUE]",
        "FROM [APP].[ORDERS]",
        "ORDER BY [OPTION_VALUE]",
      ].join("\n"),
    );
  });

  test("日付型の列は、時刻を切り捨てた yyyymmdd の文字列で取る", () => {
    const input = { source, columns, columnKey: "UPDATED_AT", limit: 10 };
    expect(
      buildFilterOptionsQuery({ ...input, dialect: "mssql" }).sql.split(
        "\n",
      )[0],
    ).toBe(
      "SELECT DISTINCT TOP (@p1) CONVERT(char(8), [UPDATED_AT], 112) AS [OPTION_VALUE]",
    );
    expect(
      buildFilterOptionsQuery({ ...input, dialect: "oracle" }).sql.split(
        "\n",
      )[0],
    ).toBe(
      `SELECT DISTINCT TO_CHAR("UPDATED_AT", 'YYYYMMDD') AS "OPTION_VALUE"`,
    );
  });

  test("値の選択に使えない型、未知の列、不正な上限はエラー", () => {
    const base = { dialect: "mssql" as const, source, columns, limit: 10 };
    expect(() =>
      buildFilterOptionsQuery({ ...base, columnKey: "NOTE" }),
    ).toThrow("値の選択で絞り込めません");
    expect(() =>
      buildFilterOptionsQuery({ ...base, columnKey: "NO_SUCH" }),
    ).toThrow("見つかりません");
    for (const limit of [0, -1, 1.5]) {
      expect(() =>
        buildFilterOptionsQuery({ ...base, columnKey: "QTY", limit }),
      ).toThrow("候補の上限は 1 以上の整数");
    }
  });
  test("16 桁以上の decimal（asText）は文字列にして取り、元の数値の順に並べる", () => {
    const wide: ColumnInfo[] = [
      {
        name: "AMOUNT",
        type: { kind: "number", precision: 33, scale: 23, asText: true },
      },
    ];
    const q = buildFilterOptionsQuery({
      dialect: "mssql",
      source,
      columns: wide,
      columnKey: "AMOUNT",
      limit: 100,
    });
    expect(q.sql).toBe(
      [
        "SELECT DISTINCT TOP (@p1) CONVERT(varchar(40), [AMOUNT]) AS [OPTION_VALUE], [AMOUNT] AS [OPTION_ORDER]",
        "FROM [APP].[ORDERS]",
        "ORDER BY [OPTION_ORDER]",
      ].join("\n"),
    );
  });
});

describe("toFilterOptions", () => {
  test("NULL と空文字は空欄の 1 件にまとめる", () => {
    expect(
      toFilterOptions(column("ORDER_NO"), [null, "", "A", "B"], 10),
    ).toEqual({
      options: [
        { label: "（空白）", value: "" },
        { label: "A", value: "A" },
        { label: "B", value: "B" },
      ],
      truncated: false,
    });
  });

  test("上限より多く取れたら打ち切り", () => {
    expect(toFilterOptions(column("ORDER_NO"), ["A", "B", "C"], 2)).toEqual({
      options: [
        { label: "A", value: "A" },
        { label: "B", value: "B" },
      ],
      truncated: true,
    });
    expect(toFilterOptions(column("ORDER_NO"), ["A", "B"], 2).truncated).toBe(
      false,
    );
  });

  test("日付は 'YYYY-MM-DD'。yyyymmdd の文字列で日付でない値はそのまま", () => {
    expect(
      toFilterOptions(column("ORDER_YMD"), ["20260924", "00000000"], 10)
        .options,
    ).toEqual([
      { label: "2026-09-24", value: "2026-09-24" },
      { label: "00000000", value: "00000000" },
    ]);
    expect(
      toFilterOptions(column("UPDATED_AT"), ["20260924"], 10).options,
    ).toEqual([{ label: "2026-09-24", value: "2026-09-24" }]);
  });

  test("数値は文字列にする（精度のため文字列で届いた値はそのまま）", () => {
    expect(
      toFilterOptions(
        column("QTY"),
        [1, 2.5, "12345678901234567.89"],
        10,
      ).options.map((o) => o.value),
    ).toEqual(["1", "2.5", "12345678901234567.89"]);
  });

  test("候補の値をそのまま WHERE の生成に渡せる", () => {
    const { options } = toFilterOptions(
      column("ORDER_YMD"),
      [null, "20260924", "00000000"],
      10,
    );
    const q = buildWhere({
      dialect: "mssql",
      columns,
      filters: {
        ORDER_YMD: { kind: "set", values: options.map((o) => o.value) },
      },
    });
    expect(q?.sql).toBe(
      "([ORDER_YMD] IN (@p1, @p2) OR [ORDER_YMD] IS NULL OR [ORDER_YMD] = '')",
    );
    expect(q?.params.map((p) => p.value)).toEqual(["20260924", "00000000"]);
  });
});
