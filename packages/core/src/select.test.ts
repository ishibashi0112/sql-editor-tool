import { describe, expect, test } from "vitest";
import type { ColumnFilterValue, SortEntry } from "./filter";
import type { ColumnInfo } from "./schema";
import { buildSelect } from "./select";
import { columns } from "./testColumns";

const source = {
  kind: "table",
  table: { schema: "APP", name: "ORDERS" },
} as const;
const filters: Record<string, ColumnFilterValue> = {
  ORDER_NO: { kind: "set", values: ["A", "B"] },
  QTY: {
    kind: "number",
    raw: "",
    parsed: { mode: "comparison", operator: ">", value: 0 },
  },
};
const sort: SortEntry[] = [
  { columnKey: "ORDER_NO", direction: "asc" },
  { columnKey: "QTY", direction: "desc" },
];

describe("buildSelect", () => {
  test("SQL Server：TOP で件数を制限する", () => {
    const q = buildSelect({
      dialect: "mssql",
      source,
      columns,
      filters,
      sort,
      limit: 100001,
    });
    expect(q.sql).toBe(
      [
        "SELECT TOP (@p1) *",
        "FROM [APP].[ORDERS]",
        "WHERE [ORDER_NO] IN (@p2, @p3)",
        "  AND [QTY] > @p4",
        "ORDER BY [ORDER_NO] ASC, [QTY] DESC",
      ].join("\n"),
    );
    expect(q.params[0]).toEqual({
      name: "p1",
      value: 100001,
      type: { kind: "integer" },
    });
    expect(q.literalSql.split("\n")[0]).toBe("SELECT TOP (100001) *");
  });

  test("Oracle：FETCH FIRST で件数を制限する", () => {
    const q = buildSelect({
      dialect: "oracle",
      source,
      columns,
      filters,
      sort,
      limit: 100001,
    });
    expect(q.sql).toBe(
      [
        "SELECT *",
        'FROM "APP"."ORDERS"',
        'WHERE "ORDER_NO" IN (:p1, :p2)',
        '  AND "QTY" > :p3',
        'ORDER BY "ORDER_NO" ASC, "QTY" DESC',
        "FETCH FIRST :p4 ROWS ONLY",
      ].join("\n"),
    );
    expect(q.literalSql).toBe(
      [
        "SELECT *",
        'FROM "APP"."ORDERS"',
        `WHERE "ORDER_NO" IN ('A', 'B')`,
        '  AND "QTY" > 0',
        'ORDER BY "ORDER_NO" ASC, "QTY" DESC',
        "FETCH FIRST 100001 ROWS ONLY",
      ].join("\n"),
    );
  });

  test("条件・並び順・件数制限がなければ最小の形", () => {
    const q = buildSelect({ dialect: "mssql", source, columns });
    expect(q.sql).toBe("SELECT *\nFROM [APP].[ORDERS]");
    expect(q.params).toEqual([]);
  });

  test("識別子の引用符を重ねる", () => {
    expect(
      buildSelect({
        dialect: "mssql",
        source: { kind: "table", table: { schema: "dbo", name: "A]B" } },
        columns,
      }).sql,
    ).toBe("SELECT *\nFROM [dbo].[A]]B]");
    expect(
      buildSelect({
        dialect: "oracle",
        source: { kind: "table", table: { schema: "APP", name: 'A"B' } },
        columns,
      }).sql,
    ).toBe('SELECT *\nFROM "APP"."A""B"');
  });

  test("件数の上限は 1 以上の整数", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        buildSelect({ dialect: "mssql", source, columns, limit }),
      ).toThrow("1 以上の整数");
    }
  });

  test("16 桁以上の decimal（asText）があれば列を並べ、その列だけ文字列にして取る", () => {
    const wide: ColumnInfo[] = [
      {
        name: "ID",
        type: { kind: "number", precision: 19, scale: 0, asText: true },
      },
      {
        name: "NAME",
        type: { kind: "string", unicode: true, fixedLength: false, length: 20 },
      },
    ];
    const q = buildSelect({
      dialect: "mssql",
      source,
      columns: wide,
      sort: [{ columnKey: "ID", direction: "asc" }],
      limit: 10,
    });
    expect(q.sql).toBe(
      [
        "SELECT TOP (@p1)",
        "  CONVERT(varchar(40), [ID]) AS [ID],",
        "  [NAME]",
        "FROM [APP].[ORDERS]",
        // 並べ替えは元の数値の列（文字列にした別名ではない）
        "ORDER BY [ID] ASC",
      ].join("\n"),
    );
  });

  test("未知の列で並べ替えはエラー", () => {
    expect(() =>
      buildSelect({
        dialect: "mssql",
        source,
        columns,
        sort: [{ columnKey: "NO_SUCH", direction: "asc" }],
      }),
    ).toThrow("並べ替えの列");
  });
});

describe("buildSelect の where（差分カメラの表ごとの条件、D-47）", () => {
  const input = {
    dialect: "mssql" as const,
    source: { kind: "table" as const, table: { schema: "dbo", name: "受注" } },
    columns: [],
  };

  test("条件式を別の行に置いて括弧で包む（行の終わりの -- コメントで閉じ括弧が消えない）", () => {
    expect(
      buildSelect({
        ...input,
        where: "  受注日 >= '20260901' -- 今月  ",
        limit: 101,
      }).literalSql,
    ).toBe(
      "SELECT TOP (101) *\nFROM [dbo].[受注]\nWHERE (\n受注日 >= '20260901' -- 今月\n)",
    );
  });

  test("空・; ・バインド変数・閉じていない文字列はエラー", () => {
    expect(() => buildSelect({ ...input, where: " " })).toThrow("条件が空です");
    expect(() =>
      buildSelect({ ...input, where: "a = 1; DELETE FROM x" }),
    ).toThrow("条件に ; は書けません");
    expect(() => buildSelect({ ...input, where: "a = :x" })).toThrow(
      "バインド変数（:x）",
    );
    expect(() => buildSelect({ ...input, where: "a = 'x" })).toThrow(
      "文字列が閉じていません",
    );
  });
});
