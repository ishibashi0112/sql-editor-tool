import { describe, expect, test } from "vitest";
import type { DialectName } from "./dialect";
import { QueryBuildError } from "./errors";
import type { ColumnFilterValue } from "./filter";
import { buildWhere } from "./select";
import { columns } from "./testColumns";
import type { ResolveDatePreset } from "./where";

// 2026-09-23 10:00（ローカル時刻）
const now = new Date(2026, 8, 23, 10, 0);

function where(
  dialect: DialectName,
  filters: Record<string, ColumnFilterValue>,
  resolveDatePreset?: ResolveDatePreset,
) {
  return buildWhere({
    dialect,
    columns,
    filters,
    now,
    ...(resolveDatePreset ? { resolveDatePreset } : {}),
  });
}

/** 生成された条件の SQL とバインド値だけを見る */
function sqlOf(
  dialect: DialectName,
  filters: Record<string, ColumnFilterValue>,
) {
  return where(dialect, filters)?.sql ?? null;
}

function valuesOf(
  dialect: DialectName,
  filters: Record<string, ColumnFilterValue>,
) {
  return where(dialect, filters)?.params.map((p) => p.value) ?? [];
}

const str = (value: string, unicode = false) => ({
  kind: "string" as const,
  unicode,
  value,
});

describe("文字列の条件", () => {
  test("部分一致は LIKE とエスケープ。NVARCHAR 列は unicode でバインドする", () => {
    const q = where("mssql", {
      CUST_NAME: {
        kind: "textSet",
        condition: { mode: "contains", value: "abc" },
        set: null,
      },
    });
    expect(q?.sql).toBe("[CUST_NAME] LIKE @p1 ESCAPE '\\'");
    expect(q?.params).toEqual([
      { name: "p1", value: "%abc%", type: { kind: "string", unicode: true } },
    ]);
  });

  test("前方一致と後方一致", () => {
    const f = (mode: "startsWith" | "endsWith") => ({
      ORDER_NO: {
        kind: "textSet" as const,
        condition: { mode, value: "A1" },
        set: null,
      },
    });
    expect(valuesOf("oracle", f("startsWith"))).toEqual(["A1%"]);
    expect(valuesOf("oracle", f("endsWith"))).toEqual(["%A1"]);
  });

  test("LIKE の特殊文字をエスケープする。SQL Server だけ [ も対象", () => {
    const filters = {
      ORDER_NO: { kind: "text" as const, value: "50%_off[1]\\x" },
    };
    expect(valuesOf("mssql", filters)).toEqual(["%50\\%\\_off\\[1]\\\\x%"]);
    expect(valuesOf("oracle", filters)).toEqual(["%50\\%\\_off[1]\\\\x%"]);
  });

  test("text は前後の空白を除いた部分一致。空なら条件なし", () => {
    expect(
      valuesOf("mssql", { ORDER_NO: { kind: "text", value: "  A1 " } }),
    ).toEqual(["%A1%"]);
    expect(sqlOf("mssql", { ORDER_NO: { kind: "text", value: "   " } })).toBe(
      null,
    );
  });

  test("等しい：Oracle の CHAR 列は値の側を RPAD で埋める", () => {
    const filters = {
      CUST_CD: {
        kind: "textSet" as const,
        condition: { mode: "equals" as const, value: "C01" },
        set: null,
      },
    };
    expect(sqlOf("mssql", filters)).toBe("[CUST_CD] = @p1");
    expect(sqlOf("oracle", filters)).toBe('"CUST_CD" = RPAD(:p1, 6)');
  });

  test("等しい：列長ちょうどの値は埋めない", () => {
    expect(
      sqlOf("oracle", {
        CUST_CD: {
          kind: "textSet",
          condition: { mode: "equals", value: "C00001" },
          set: null,
        },
      }),
    ).toBe('"CUST_CD" = :p1');
  });

  test("後方一致：CHAR 列は RTRIM してから比べる", () => {
    expect(
      sqlOf("oracle", {
        CUST_CD: {
          kind: "textSet",
          condition: { mode: "endsWith", value: "01" },
          set: null,
        },
      }),
    ).toBe(`RTRIM("CUST_CD") LIKE :p1 ESCAPE '\\'`);
  });

  test("空欄：SQL Server は NULL と空文字、Oracle は NULL だけ", () => {
    const blank = {
      ORDER_NO: {
        kind: "textSet" as const,
        condition: { mode: "blank" as const },
        set: null,
      },
    };
    const notBlank = {
      ORDER_NO: {
        kind: "textSet" as const,
        condition: { mode: "notBlank" as const },
        set: null,
      },
    };
    expect(sqlOf("mssql", blank)).toBe(
      "([ORDER_NO] IS NULL OR [ORDER_NO] = '')",
    );
    expect(sqlOf("oracle", blank)).toBe('"ORDER_NO" IS NULL');
    expect(sqlOf("mssql", notBlank)).toBe(
      "([ORDER_NO] IS NOT NULL AND [ORDER_NO] <> '')",
    );
    expect(sqlOf("oracle", notBlank)).toBe('"ORDER_NO" IS NOT NULL');
  });

  test("select は完全一致", () => {
    expect(sqlOf("mssql", { ORDER_NO: { kind: "select", value: "A1" } })).toBe(
      "[ORDER_NO] = @p1",
    );
    expect(sqlOf("mssql", { ORDER_NO: { kind: "select", value: "" } })).toBe(
      null,
    );
  });

  test("文字列でない列に文字列の条件はエラー", () => {
    expect(() => where("mssql", { QTY: { kind: "text", value: "1" } })).toThrow(
      QueryBuildError,
    );
  });
});

describe("数値の条件", () => {
  test("比較。!= は <> にする", () => {
    const q = where("mssql", {
      QTY: {
        kind: "number",
        raw: "10 以上",
        parsed: { mode: "comparison", operator: ">=", value: 10 },
      },
    });
    expect(q?.sql).toBe("[QTY] >= @p1");
    expect(q?.params).toEqual([
      { name: "p1", value: 10, type: { kind: "number" } },
    ]);
    expect(
      sqlOf("oracle", {
        QTY: {
          kind: "number",
          raw: "",
          parsed: { mode: "comparison", operator: "!=", value: 0 },
        },
      }),
    ).toBe('"QTY" <> :p1');
  });

  test("範囲は両端を含む", () => {
    expect(
      sqlOf("mssql", {
        QTY: {
          kind: "numberSet",
          condition: { mode: "range", min: 1, max: 5 },
          set: null,
        },
      }),
    ).toBe("([QTY] >= @p1 AND [QTY] <= @p2)");
  });

  test("空欄は IS NULL だけ", () => {
    expect(
      sqlOf("mssql", {
        QTY: {
          kind: "numberSet",
          condition: { mode: "blank" },
          set: null,
        },
      }),
    ).toBe("[QTY] IS NULL");
  });

  test("解釈できなかった数値の条件はエラー", () => {
    expect(() =>
      where("mssql", { QTY: { kind: "number", raw: "abc", parsed: null } }),
    ).toThrow("解釈できません");
  });

  test("数値でない列に数値の条件はエラー", () => {
    expect(() =>
      where("mssql", {
        ORDER_NO: {
          kind: "numberSet",
          condition: { mode: "comparison", operator: ">", value: 1 },
          set: null,
        },
      }),
    ).toThrow("数値の列ではない");
  });

  test("条件と値の選択は AND。選択の値は文字列のまま数値型でバインドする", () => {
    const q = where("mssql", {
      QTY: {
        kind: "numberSet",
        condition: { mode: "comparison", operator: ">", value: 0 },
        set: { values: ["1", "2.5"] },
      },
    });
    expect(q?.sql).toBe("([QTY] > @p1 AND [QTY] IN (@p2, @p3))");
    expect(q?.params.map((p) => [p.value, p.type.kind])).toEqual([
      [0, "number"],
      ["1", "number"],
      ["2.5", "number"],
    ]);
  });

  test("数値の列で数値でない選択値はエラー", () => {
    expect(() =>
      where("mssql", {
        QTY: { kind: "numberSet", condition: null, set: { values: ["x"] } },
      }),
    ).toThrow("数値ではありません");
  });
});

describe("値の選択（集合フィルタ）", () => {
  const set = (
    values: string[],
    mode?: "include" | "exclude",
  ): Record<string, ColumnFilterValue> => ({
    ORDER_NO: { kind: "set", values, ...(mode ? { mode } : {}) },
  });

  test("複数なら IN、1 つなら =", () => {
    expect(sqlOf("mssql", set(["A", "B"]))).toBe("[ORDER_NO] IN (@p1, @p2)");
    expect(sqlOf("mssql", set(["A"]))).toBe("[ORDER_NO] = @p1");
  });

  test("重複した値は 1 つにまとめる", () => {
    expect(valuesOf("mssql", set(["A", "A", "B"]))).toEqual(["A", "B"]);
  });

  test("空欄を含む選択", () => {
    expect(sqlOf("mssql", set(["A", "B", ""]))).toBe(
      "([ORDER_NO] IN (@p1, @p2) OR [ORDER_NO] IS NULL OR [ORDER_NO] = '')",
    );
    expect(sqlOf("oracle", set(["A", ""]))).toBe(
      '("ORDER_NO" = :p1 OR "ORDER_NO" IS NULL)',
    );
    expect(sqlOf("mssql", set([""]))).toBe(
      "([ORDER_NO] IS NULL OR [ORDER_NO] = '')",
    );
  });

  test("何も選ばなければ 1 行も出さない", () => {
    expect(sqlOf("mssql", set([]))).toBe("1 = 0");
  });

  test("反転：空欄の行は残す（NOT IN だけだと NULL の行が消えるため）", () => {
    expect(sqlOf("mssql", set(["A", "B"], "exclude"))).toBe(
      "([ORDER_NO] NOT IN (@p1, @p2) OR [ORDER_NO] IS NULL OR [ORDER_NO] = '')",
    );
    expect(sqlOf("oracle", set(["A"], "exclude"))).toBe(
      '("ORDER_NO" <> :p1 OR "ORDER_NO" IS NULL)',
    );
  });

  test("反転：空欄も除く指定なら、空欄でないことを明示する", () => {
    expect(sqlOf("mssql", set(["A", "B", ""], "exclude"))).toBe(
      "([ORDER_NO] IS NOT NULL AND [ORDER_NO] <> '' AND [ORDER_NO] NOT IN (@p1, @p2))",
    );
    expect(sqlOf("oracle", set([""], "exclude"))).toBe(
      '"ORDER_NO" IS NOT NULL',
    );
  });

  test("反転で何も除かなければ条件なし", () => {
    expect(sqlOf("mssql", set([], "exclude"))).toBe(null);
  });

  test("Oracle は IN の要素を 1000 個ずつに分けて繋ぐ", () => {
    const values = Array.from({ length: 1001 }, (_, i) => `V${i}`);
    const q = where("oracle", set(values));
    expect(q?.params).toHaveLength(1001);
    expect(q?.sql).toMatch(
      /^\("ORDER_NO" IN \(:p1, .*, :p1000\) OR "ORDER_NO" IN \(:p1001\)\)$/,
    );

    const excluded = where("oracle", set(values, "exclude"));
    expect(excluded?.sql).toMatch(
      /^\(\("ORDER_NO" NOT IN \(:p1, .*, :p1000\) AND "ORDER_NO" NOT IN \(:p1001\)\) OR "ORDER_NO" IS NULL\)$/,
    );
  });

  test("SQL Server はバインド変数が多すぎるとエラー", () => {
    const values = Array.from({ length: 2001 }, (_, i) => `V${i}`);
    expect(() => where("mssql", set(values))).toThrow("多すぎます");
    expect(() => where("oracle", set(values))).not.toThrow();
  });

  test("Oracle の CHAR 列は、列長に満たない値だけ RPAD で埋める", () => {
    expect(
      sqlOf("oracle", { CUST_CD: { kind: "set", values: ["C1", "C00002"] } }),
    ).toBe('"CUST_CD" IN (RPAD(:p1, 6), :p2)');
  });

  test("CLOB などの列は値の選択で絞り込めない。空欄は使える", () => {
    expect(() =>
      where("oracle", { NOTE: { kind: "set", values: ["x"] } }),
    ).toThrow("値の選択で絞り込めません");
    expect(sqlOf("oracle", { NOTE: { kind: "set", values: [""] } })).toBe(
      '"NOTE" IS NULL',
    );
  });
});

describe("日付の条件：yyyymmdd の文字列の列", () => {
  const cond = (
    condition: Extract<ColumnFilterValue, { kind: "dateSet" }>["condition"],
  ): Record<string, ColumnFilterValue> => ({
    ORDER_YMD: { kind: "dateSet", condition, set: null },
  });

  test("範囲は文字列の大小で比べる", () => {
    const q = where(
      "mssql",
      cond({ mode: "range", from: "2026-09-01", to: "2026-09-30" }),
    );
    expect(q?.sql).toBe("([ORDER_YMD] >= @p1 AND [ORDER_YMD] <= @p2)");
    expect(q?.params.map((p) => ({ ...p.type, value: p.value }))).toEqual([
      str("20260901"),
      str("20260930"),
    ]);
  });

  test("等しい・以降", () => {
    expect(sqlOf("oracle", cond({ mode: "equals", value: "2026-09-23" }))).toBe(
      '"ORDER_YMD" = :p1',
    );
    expect(
      sqlOf("mssql", cond({ mode: "onOrAfter", value: "2026-09-23" })),
    ).toBe("[ORDER_YMD] >= @p1");
  });

  test("以前・等しくない：SQL Server は空文字が引っかからないようにする", () => {
    expect(
      sqlOf("mssql", cond({ mode: "onOrBefore", value: "2026-09-23" })),
    ).toBe("([ORDER_YMD] <= @p1 AND [ORDER_YMD] <> '')");
    expect(
      sqlOf("oracle", cond({ mode: "onOrBefore", value: "2026-09-23" })),
    ).toBe('"ORDER_YMD" <= :p1');
    expect(
      sqlOf("mssql", cond({ mode: "notEquals", value: "2026-09-23" })),
    ).toBe("([ORDER_YMD] <> @p1 AND [ORDER_YMD] <> '')");
  });

  test("CHAR(8) の列でも RPAD は付けない（値が列長ちょうどのため）", () => {
    expect(
      sqlOf("oracle", {
        SHIP_YMD: {
          kind: "dateSet",
          condition: { mode: "equals", value: "2026-09-23" },
          set: null,
        },
      }),
    ).toBe('"SHIP_YMD" = :p1');
  });

  test("選択：日付は yyyymmdd に戻し、日付でない値はそのまま使う", () => {
    const q = where("mssql", {
      ORDER_YMD: {
        kind: "dateSet",
        condition: null,
        set: { values: ["2026-09-01", "", "00000000"] },
      },
    });
    expect(q?.sql).toBe(
      "([ORDER_YMD] IN (@p1, @p2) OR [ORDER_YMD] IS NULL OR [ORDER_YMD] = '')",
    );
    expect(q?.params.map((p) => p.value)).toEqual(["20260901", "00000000"]);
  });

  test("意味型が日付でない文字列の列に日付の条件はエラー", () => {
    expect(() =>
      where("mssql", {
        ORDER_NO: {
          kind: "dateSet",
          condition: { mode: "equals", value: "2026-09-23" },
          set: null,
        },
      }),
    ).toThrow("意味型を日付に");
  });

  test("実在しない日付はエラー", () => {
    expect(() =>
      where("mssql", cond({ mode: "equals", value: "2026-02-30" })),
    ).toThrow("正しくありません");
  });
});

describe("日付の条件：日付型の列", () => {
  const cond = (
    column: string,
    condition: Extract<ColumnFilterValue, { kind: "dateSet" }>["condition"],
  ): Record<string, ColumnFilterValue> => ({
    [column]: { kind: "dateSet", condition, set: null },
  });

  test("時刻を持ちうる列の「等しい」は、当日から翌日の前までの範囲", () => {
    const filters = cond("UPDATED_AT", { mode: "equals", value: "2026-09-23" });
    expect(sqlOf("mssql", filters)).toBe(
      "([UPDATED_AT] >= CONVERT(date, @p1, 112) AND [UPDATED_AT] < CONVERT(date, @p2, 112))",
    );
    expect(sqlOf("oracle", filters)).toBe(
      `("UPDATED_AT" >= TO_DATE(:p1, 'YYYYMMDD') AND "UPDATED_AT" < TO_DATE(:p2, 'YYYYMMDD'))`,
    );
    expect(valuesOf("oracle", filters)).toEqual(["20260923", "20260924"]);
  });

  test("時刻を持ちうる列：以前・範囲は翌日の前まで、等しくないは範囲の外", () => {
    expect(
      sqlOf(
        "mssql",
        cond("UPDATED_AT", { mode: "onOrBefore", value: "2026-09-30" }),
      ),
    ).toBe("[UPDATED_AT] < CONVERT(date, @p1, 112)");
    expect(
      valuesOf(
        "mssql",
        cond("UPDATED_AT", { mode: "onOrBefore", value: "2026-09-30" }),
      ),
    ).toEqual(["20261001"]);
    expect(
      sqlOf(
        "oracle",
        cond("UPDATED_AT", {
          mode: "range",
          from: "2026-12-01",
          to: "2026-12-31",
        }),
      ),
    ).toBe(
      `("UPDATED_AT" >= TO_DATE(:p1, 'YYYYMMDD') AND "UPDATED_AT" < TO_DATE(:p2, 'YYYYMMDD'))`,
    );
    expect(
      valuesOf(
        "oracle",
        cond("UPDATED_AT", {
          mode: "range",
          from: "2026-12-01",
          to: "2026-12-31",
        }),
      ),
    ).toEqual(["20261201", "20270101"]);
    expect(
      sqlOf(
        "mssql",
        cond("UPDATED_AT", { mode: "notEquals", value: "2026-09-23" }),
      ),
    ).toBe(
      "([UPDATED_AT] < CONVERT(date, @p1, 112) OR [UPDATED_AT] >= CONVERT(date, @p2, 112))",
    );
  });

  test("時刻を持たない列は、そのまま比べる", () => {
    expect(
      sqlOf("mssql", cond("DUE_DATE", { mode: "equals", value: "2026-09-23" })),
    ).toBe("[DUE_DATE] = CONVERT(date, @p1, 112)");
    expect(
      sqlOf(
        "mssql",
        cond("DUE_DATE", { mode: "onOrBefore", value: "2026-09-23" }),
      ),
    ).toBe("[DUE_DATE] <= CONVERT(date, @p1, 112)");
  });

  test("日付型の列の空欄は IS NULL だけ", () => {
    expect(sqlOf("mssql", cond("UPDATED_AT", { mode: "blank" }))).toBe(
      "[UPDATED_AT] IS NULL",
    );
  });

  test("選択：時刻を持ちうる列は日ごとの範囲を OR で繋ぐ", () => {
    const filters = (mode?: "exclude"): Record<string, ColumnFilterValue> => ({
      UPDATED_AT: {
        kind: "dateSet",
        condition: null,
        set: {
          values: ["2026-09-01", "2026-09-02"],
          ...(mode ? { mode } : {}),
        },
      },
    });
    expect(sqlOf("oracle", filters())).toBe(
      `(("UPDATED_AT" >= TO_DATE(:p1, 'YYYYMMDD') AND "UPDATED_AT" < TO_DATE(:p2, 'YYYYMMDD'))` +
        ` OR ("UPDATED_AT" >= TO_DATE(:p3, 'YYYYMMDD') AND "UPDATED_AT" < TO_DATE(:p4, 'YYYYMMDD')))`,
    );
    expect(sqlOf("oracle", filters("exclude"))).toBe(
      `(NOT (("UPDATED_AT" >= TO_DATE(:p1, 'YYYYMMDD') AND "UPDATED_AT" < TO_DATE(:p2, 'YYYYMMDD'))` +
        ` OR ("UPDATED_AT" >= TO_DATE(:p3, 'YYYYMMDD') AND "UPDATED_AT" < TO_DATE(:p4, 'YYYYMMDD')))` +
        ` OR "UPDATED_AT" IS NULL)`,
    );
  });

  test("選択：時刻を持たない列は IN", () => {
    expect(
      sqlOf("mssql", {
        DUE_DATE: {
          kind: "dateSet",
          condition: null,
          set: { values: ["2026-09-01", "2026-09-02"] },
        },
      }),
    ).toBe("[DUE_DATE] IN (CONVERT(date, @p1, 112), CONVERT(date, @p2, 112))");
  });

  test("日付型の列に日付でない選択値はエラー", () => {
    expect(() =>
      where("mssql", {
        DUE_DATE: { kind: "dateSet", condition: null, set: { values: ["x"] } },
      }),
    ).toThrow("正しくありません");
  });
});

describe("日付のプリセット", () => {
  const preset = (id: string): Record<string, ColumnFilterValue> => ({
    ORDER_YMD: {
      kind: "dateSet",
      condition: { mode: "preset", preset: id },
      set: null,
    },
  });

  test("組み込みのプリセットは now を基準に解決する", () => {
    expect(valuesOf("mssql", preset("today"))).toEqual([
      "20260923",
      "20260923",
    ]);
    expect(valuesOf("mssql", preset("thisMonth"))).toEqual([
      "20260901",
      "20260930",
    ]);
    // 今日を含む過去 30 日間
    expect(valuesOf("mssql", preset("last30days"))).toEqual([
      "20260825",
      "20260923",
    ]);
  });

  test("カスタムのプリセット：片側だけなら以降／以前、逆順なら入れ替える", () => {
    const resolve: ResolveDatePreset = (_column, id) => {
      if (id === "fromNewYear") return { from: "2026-01-01" };
      if (id === "reversed") return { from: "2026-03-31", to: "2026-03-01" };
      return undefined;
    };
    expect(where("mssql", preset("fromNewYear"), resolve)?.sql).toBe(
      "[ORDER_YMD] >= @p1",
    );
    expect(
      where("mssql", preset("reversed"), resolve)?.params.map((p) => p.value),
    ).toEqual(["20260301", "20260331"]);
    // カスタムにない ID は組み込みを探す
    expect(
      where("mssql", preset("today"), resolve)?.params.map((p) => p.value),
    ).toEqual(["20260923", "20260923"]);
  });

  test("解決できないプリセットは条件なし（グリッドと同じ）", () => {
    expect(sqlOf("mssql", preset("unknown"))).toBe(null);
  });
});

describe("全体", () => {
  test("列の条件は columns の並び順に AND で結ぶ", () => {
    expect(
      sqlOf("mssql", {
        QTY: {
          kind: "number",
          raw: "",
          parsed: { mode: "comparison", operator: ">", value: 0 },
        },
        ORDER_NO: { kind: "set", values: ["A"] },
      }),
    ).toBe("[ORDER_NO] = @p1\n  AND [QTY] > @p2");
  });

  test("条件がなければ null", () => {
    expect(where("mssql", {})).toBe(null);
  });

  test("未知の列はエラー（列キーを持つ）", () => {
    try {
      where("mssql", { NO_SUCH: { kind: "text", value: "x" } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QueryBuildError);
      expect((e as QueryBuildError).columnKey).toBe("NO_SUCH");
    }
  });

  test("custom はエラー", () => {
    expect(() =>
      where("mssql", { ORDER_NO: { kind: "custom", value: 1 } }),
    ).toThrow("カスタムフィルタ");
  });

  test("列名が constructor でも Object.prototype を拾わない", () => {
    const q = buildWhere({
      dialect: "mssql",
      columns: [
        {
          name: "constructor",
          type: {
            kind: "string",
            unicode: false,
            fixedLength: false,
            length: 1,
          },
        },
      ],
      filters: {},
    });
    expect(q).toBe(null);
  });

  test("リテラル版：SQL Server の unicode は N'…'、引用符は重ねる", () => {
    const q = where("mssql", {
      CUST_NAME: { kind: "text", value: "O'Reilly" },
      QTY: {
        kind: "number",
        raw: "",
        parsed: { mode: "comparison", operator: "=", value: 3 },
      },
    });
    expect(q?.literalSql).toBe(
      "[CUST_NAME] LIKE N'%O''Reilly%' ESCAPE '\\'\n  AND [QTY] = 3",
    );
  });

  test("リテラル版：Oracle の日付", () => {
    expect(
      where("oracle", {
        DUE_DATE: {
          kind: "dateSet",
          condition: { mode: "equals", value: "2026-09-23" },
          set: null,
        },
      })?.literalSql,
    ).toBe(`"DUE_DATE" = TO_DATE('20260923', 'YYYYMMDD')`);
  });
});
