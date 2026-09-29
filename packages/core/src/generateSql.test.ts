import { describe, expect, test } from "vitest";
import { namedParams } from "./baseSql";
import { mssql, oracle } from "./dialect";
import { formatSql } from "./format";
import {
  DEFAULT_GENERATE_LAYOUT,
  DEFAULT_GENERATE_OPTIONS,
  type GenerateKind,
  type GenerateLayout,
  generateSql,
  paramTypeForColumn,
} from "./generateSql";
import type { ColumnInfo } from "./schema";

const str = (name: string, logicalName?: string): ColumnInfo => ({
  name,
  type: { kind: "string", unicode: true, fixedLength: false, length: 10 },
  ...(logicalName ? { logicalName } : {}),
});
const num = (name: string, logicalName?: string): ColumnInfo => ({
  name,
  type: { kind: "number", precision: 10, scale: 0 },
  ...(logicalName ? { logicalName } : {}),
});

// 例の表と列は架空
const lines: ColumnInfo[] = [
  str("ORDER_NO", "受注番号"),
  num("LINE_NO", "行番号"),
  str("ITEM_CD", "品目コード"),
  num("QTY", "数量"),
];
const table = { schema: "SALES", name: "ORDER_LINES" };

describe("generateSql：SELECT", () => {
  test("A5 と同じ形：列ごとの行、論理名のコメント、主キーで絞って並べる", () => {
    const { sql, params } = generateSql(
      oracle,
      "select",
      {
        table,
        logicalName: "受注明細",
        columns: lines,
        keys: ["ORDER_NO", "LINE_NO"],
      },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(sql).toBe(
      [
        "-- SALES.ORDER_LINES（受注明細）",
        "SELECT",
        "    ORDER_NO,            -- 受注番号",
        "    LINE_NO,             -- 行番号",
        "    ITEM_CD,             -- 品目コード",
        "    QTY                  -- 数量",
        "FROM",
        "    SALES.ORDER_LINES    -- 受注明細",
        "WHERE",
        "    ORDER_NO = :ORDER_NO",
        "    AND LINE_NO = :LINE_NO",
        "ORDER BY",
        "    ORDER_NO,",
        "    LINE_NO",
        "",
      ].join("\n"),
    );
    expect(params.map((p) => [p.name, p.column.name])).toEqual([
      ["ORDER_NO", "ORDER_NO"],
      ["LINE_NO", "LINE_NO"],
    ]);
  });

  test("書いた :名前 は、実行のときの入力欄になる", () => {
    const { sql, params } = generateSql(
      mssql,
      "select",
      { table, columns: lines, keys: ["ORDER_NO", "LINE_NO"] },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(namedParams(mssql, sql)).toEqual(params.map((p) => p.name));
  });

  test("論理名のない列・表にはコメントを付けない。論理名がひとつもなければコメントなし", () => {
    const { sql } = generateSql(
      mssql,
      "select",
      {
        table,
        columns: [str("ORDER_NO"), str("ITEM_CD", "品目コード"), num("QTY")],
        keys: [],
      },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(sql).toBe(
      [
        "-- SALES.ORDER_LINES",
        "SELECT",
        "    ORDER_NO,",
        "    ITEM_CD,    -- 品目コード",
        "    QTY",
        "FROM",
        "    SALES.ORDER_LINES",
        "",
      ].join("\n"),
    );
    const none = generateSql(
      mssql,
      "select",
      { table, columns: [str("ORDER_NO"), num("QTY")], keys: [] },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(none.sql).not.toContain("  --");
  });

  test("キーがなければ WHERE と ORDER BY を付けない（主キーのない表で、列の設定のキーもない）", () => {
    const { sql, params } = generateSql(
      mssql,
      "select",
      { table, columns: lines, keys: [] },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(sql).not.toContain("WHERE");
    expect(sql).not.toContain("ORDER BY");
    expect(params).toEqual([]);
  });

  test("表にないキーの列は使わない", () => {
    const { params } = generateSql(
      mssql,
      "select",
      { table, columns: lines, keys: ["ORDER_NO", "OLD_KEY"] },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(params.map((p) => p.name)).toEqual(["ORDER_NO"]);
  });

  test("選んだものだけ付ける：表の名前なし・絞らない・並べない・コメントなし・スキーマなし", () => {
    const { sql, params } = generateSql(
      oracle,
      "select",
      {
        table,
        logicalName: "受注明細",
        columns: lines,
        keys: ["ORDER_NO"],
      },
      {
        title: false,
        whereKeys: false,
        orderByKeys: false,
        comments: false,
        qualifySchema: false,
      },
    );
    expect(sql).toBe(
      [
        "SELECT",
        "    ORDER_NO,",
        "    LINE_NO,",
        "    ITEM_CD,",
        "    QTY",
        "FROM",
        "    ORDER_LINES",
        "",
      ].join("\n"),
    );
    expect(params).toEqual([]);
  });

  test("絞らずに並べるだけ", () => {
    const { sql } = generateSql(
      mssql,
      "select",
      { table, columns: lines, keys: ["ORDER_NO", "LINE_NO"] },
      { ...DEFAULT_GENERATE_OPTIONS, whereKeys: false, comments: false },
    );
    expect(sql).toContain("FROM\n    SALES.ORDER_LINES\nORDER BY\n");
  });

  test("予約語・記号・Oracle の小文字を含む名前は引用符で囲む", () => {
    const columns = [str("DATE"), str("item cd"), str("Memo")];
    const ora = generateSql(
      oracle,
      "select",
      {
        table: { schema: "SALES", name: "Order" },
        columns,
        keys: ["DATE"],
      },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(ora.sql).toContain('    "DATE",\n    "item cd",\n    "Memo"\n');
    expect(ora.sql).toContain('    SALES."Order"\n');
    expect(ora.sql).toContain('    "DATE" = :DATE\n');
    const ms = generateSql(
      mssql,
      "select",
      {
        table: { schema: "dbo", name: "Order" },
        columns,
        keys: ["DATE"],
      },
      DEFAULT_GENERATE_OPTIONS,
    );
    // SQL Server は大文字小文字を区別しないので、小文字だけでは囲まない
    expect(ms.sql).toContain("    [DATE],\n    [item cd],\n    Memo\n");
    expect(ms.sql).toContain("    dbo.[Order]\n");
  });

  test("入力欄に使えない文字は _ にし、重なれば番号を付ける", () => {
    const { sql, params } = generateSql(
      oracle,
      "select",
      {
        table,
        columns: [str("AMT$"), str("AMT#"), str("item cd")],
        keys: ["AMT$", "AMT#", "item cd"],
      },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(params.map((p) => p.name)).toEqual(["AMT_", "AMT__2", "item_cd"]);
    expect(sql).toContain("    AMT$ = :AMT_\n");
    expect(sql).toContain("    AND AMT# = :AMT__2\n");
    expect(sql).toContain('    AND "item cd" = :item_cd\n');
    expect(namedParams(oracle, sql)).toEqual(["AMT_", "AMT__2", "item_cd"]);
  });

  test("日本語の列名：全角を 2 桁と数えて揃える", () => {
    const { sql } = generateSql(
      mssql,
      "select",
      {
        table: { schema: "dbo", name: "受注" },
        columns: [str("受注番号", "番号"), num("QTY", "数量")],
        keys: ["受注番号"],
      },
      { ...DEFAULT_GENERATE_OPTIONS, qualifySchema: false },
    );
    expect(sql).toBe(
      [
        "-- dbo.受注",
        "SELECT",
        "    受注番号,    -- 番号",
        "    QTY          -- 数量",
        "FROM",
        "    受注",
        "WHERE",
        "    受注番号 = :受注番号",
        "ORDER BY",
        "    受注番号",
        "",
      ].join("\n"),
    );
  });

  test("インデントの幅・タブと AND の位置は、整形の設定に合わせる", () => {
    const input = { table, columns: lines, keys: ["ORDER_NO", "LINE_NO"] };
    const options = {
      ...DEFAULT_GENERATE_OPTIONS,
      title: false,
      comments: false,
    };
    expect(
      generateSql(mssql, "select", input, options, {
        ...DEFAULT_GENERATE_LAYOUT,
        tabWidth: 2,
        logicalOperatorNewline: "after",
      }).sql,
    ).toBe(
      [
        "SELECT",
        "  ORDER_NO,",
        "  LINE_NO,",
        "  ITEM_CD,",
        "  QTY",
        "FROM",
        "  SALES.ORDER_LINES",
        "WHERE",
        "  ORDER_NO = :ORDER_NO AND",
        "  LINE_NO = :LINE_NO",
        "ORDER BY",
        "  ORDER_NO,",
        "  LINE_NO",
        "",
      ].join("\n"),
    );
    const tabs = generateSql(
      mssql,
      "select",
      { ...input, logicalName: "受注明細" },
      { ...options, comments: true },
      { ...DEFAULT_GENERATE_LAYOUT, useTabs: true },
    ).sql;
    // タブはタブの位置まで数えて揃える
    expect(tabs).toContain("\tORDER_NO,            -- 受注番号\n");
    expect(tabs).toContain("\tSALES.ORDER_LINES    -- 受注明細\n");
    expect(tabs).toContain("\tAND LINE_NO = :LINE_NO\n");
  });

  test("列が取れなかったときは *", () => {
    const { sql } = generateSql(
      mssql,
      "select",
      { table, columns: [], keys: [] },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(sql).toBe(
      "-- SALES.ORDER_LINES\nSELECT\n    *\nFROM\n    SALES.ORDER_LINES\n",
    );
  });
});

describe("generateSql：INSERT", () => {
  test("列と値を 1 行に 1 つ。論理名のコメントを両方に付ける", () => {
    const { sql, params } = generateSql(
      mssql,
      "insert",
      { table, logicalName: "受注明細", columns: lines, keys: ["ORDER_NO"] },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(sql).toBe(
      [
        "-- SALES.ORDER_LINES（受注明細）",
        "INSERT INTO",
        "    SALES.ORDER_LINES (    -- 受注明細",
        "        ORDER_NO,          -- 受注番号",
        "        LINE_NO,           -- 行番号",
        "        ITEM_CD,           -- 品目コード",
        "        QTY                -- 数量",
        "    )",
        "VALUES",
        "    (",
        "        :ORDER_NO,         -- 受注番号",
        "        :LINE_NO,          -- 行番号",
        "        :ITEM_CD,          -- 品目コード",
        "        :QTY               -- 数量",
        "    )",
        "",
      ].join("\n"),
    );
    expect(params.map((p) => p.name)).toEqual([
      "ORDER_NO",
      "LINE_NO",
      "ITEM_CD",
      "QTY",
    ]);
    expect(namedParams(mssql, sql)).toEqual(params.map((p) => p.name));
  });

  test("コメントがなく短ければ、整形と同じく 1 行にまとめる（括弧の中が expressionWidth より短いとき）", () => {
    const { sql } = generateSql(
      oracle,
      "insert",
      { table, columns: [str("ORDER_NO"), num("QTY")], keys: [] },
      { ...DEFAULT_GENERATE_OPTIONS, title: false },
    );
    expect(sql).toBe(
      [
        "INSERT INTO",
        "    SALES.ORDER_LINES (ORDER_NO, QTY)",
        "VALUES",
        "    (:ORDER_NO, :QTY)",
        "",
      ].join("\n"),
    );
    // 列は 1 行、値（: の分だけ長い）は 1 行に 1 つ
    const mixed = generateSql(
      oracle,
      "insert",
      { table, columns: lines, keys: [] },
      { ...DEFAULT_GENERATE_OPTIONS, title: false, comments: false },
      { ...DEFAULT_GENERATE_LAYOUT, expressionWidth: 34 },
    );
    expect(mixed.sql).toBe(
      [
        "INSERT INTO",
        "    SALES.ORDER_LINES (ORDER_NO, LINE_NO, ITEM_CD, QTY)",
        "VALUES",
        "    (",
        "        :ORDER_NO,",
        "        :LINE_NO,",
        "        :ITEM_CD,",
        "        :QTY",
        "    )",
        "",
      ].join("\n"),
    );
  });
});

describe("generateSql：UPDATE", () => {
  test("キーのほかの列を SET し、キーで絞る", () => {
    const { sql, params } = generateSql(
      mssql,
      "update",
      {
        table,
        logicalName: "受注明細",
        columns: lines,
        keys: ["ORDER_NO", "LINE_NO"],
      },
      DEFAULT_GENERATE_OPTIONS,
    );
    expect(sql).toBe(
      [
        "-- SALES.ORDER_LINES（受注明細）",
        "UPDATE SALES.ORDER_LINES    -- 受注明細",
        "SET",
        "    ITEM_CD = :ITEM_CD,     -- 品目コード",
        "    QTY = :QTY              -- 数量",
        "WHERE",
        "    ORDER_NO = :ORDER_NO",
        "    AND LINE_NO = :LINE_NO",
        "",
      ].join("\n"),
    );
    expect(params.map((p) => p.name)).toEqual([
      "ITEM_CD",
      "QTY",
      "ORDER_NO",
      "LINE_NO",
    ]);
  });

  test("キーしかない表は、すべての列を SET し、絞る値は別の名前にする", () => {
    const { sql } = generateSql(
      mssql,
      "update",
      {
        table,
        columns: [str("ORDER_NO"), num("LINE_NO")],
        keys: ["ORDER_NO", "LINE_NO"],
      },
      { ...DEFAULT_GENERATE_OPTIONS, title: false, qualifySchema: false },
    );
    expect(sql).toBe(
      [
        "UPDATE ORDER_LINES",
        "SET",
        "    ORDER_NO = :ORDER_NO,",
        "    LINE_NO = :LINE_NO",
        "WHERE",
        "    ORDER_NO = :ORDER_NO_2",
        "    AND LINE_NO = :LINE_NO_2",
        "",
      ].join("\n"),
    );
  });

  test("キーがなければ、条件を書いてもらう（WHERE だけでは実行できない。全部の行を変えないように）", () => {
    const { sql } = generateSql(
      oracle,
      "update",
      { table, columns: [str("MEMO")], keys: [] },
      { ...DEFAULT_GENERATE_OPTIONS, title: false },
    );
    expect(sql).toContain(
      "WHERE\n    -- 主キーがありません。変える行の条件を書いてください\n",
    );
  });
});

describe("generateSql：DELETE", () => {
  test("キーで絞る。キーがなければ、条件を書いてもらう", () => {
    const { sql } = generateSql(
      mssql,
      "delete",
      {
        table,
        logicalName: "受注明細",
        columns: lines,
        keys: ["ORDER_NO", "LINE_NO"],
      },
      DEFAULT_GENERATE_OPTIONS,
      { ...DEFAULT_GENERATE_LAYOUT, logicalOperatorNewline: "after" },
    );
    expect(sql).toBe(
      [
        "-- SALES.ORDER_LINES（受注明細）",
        "DELETE FROM SALES.ORDER_LINES    -- 受注明細",
        "WHERE",
        "    ORDER_NO = :ORDER_NO AND",
        "    LINE_NO = :LINE_NO",
        "",
      ].join("\n"),
    );
    const none = generateSql(
      mssql,
      "delete",
      { table, columns: lines, keys: [] },
      { ...DEFAULT_GENERATE_OPTIONS, title: false },
    );
    expect(none.sql).toBe(
      [
        "DELETE FROM SALES.ORDER_LINES",
        "WHERE",
        "    -- 主キーがありません。消す行の条件を書いてください",
        "",
      ].join("\n"),
    );
  });
});

describe("generateSql：整形（D-45）との関係", () => {
  test("整形しても、コメントの前の空白が 1 つに詰まるほかは変わらない（4 種類・方言・形・キーの有無・列の長さ）", () => {
    const layouts: GenerateLayout[] = [
      DEFAULT_GENERATE_LAYOUT,
      {
        tabWidth: 2,
        useTabs: false,
        logicalOperatorNewline: "after",
        expressionWidth: 50,
      },
      {
        tabWidth: 4,
        useTabs: true,
        logicalOperatorNewline: "before",
        expressionWidth: 30,
      },
    ];
    const inputs = [
      {
        table,
        logicalName: "受注明細",
        columns: lines,
        keys: ["ORDER_NO", "LINE_NO"],
      },
      // 論理名がなく短い（INSERT は 1 行にまとまる）
      { table, columns: [str("ORDER_NO"), num("QTY")], keys: ["ORDER_NO"] },
      // キーがない
      { table, columns: [str("MEMO", "備考")], keys: [] },
    ];
    const kinds: GenerateKind[] = ["select", "insert", "update", "delete"];
    for (const dialect of [mssql, oracle]) {
      for (const layout of layouts) {
        for (const input of inputs) {
          for (const kind of kinds) {
            for (const comments of [true, false]) {
              const { sql } = generateSql(
                dialect,
                kind,
                input,
                { ...DEFAULT_GENERATE_OPTIONS, comments },
                layout,
              );
              expect(formatSql(dialect, sql, layout), sql).toEqual({
                ok: true,
                text: sql.replace(/(\S) +-- /g, "$1 -- "),
                rejoined: 0,
              });
            }
          }
        }
      }
    }
  });
});

describe("paramTypeForColumn", () => {
  test("数値・日付・yyyymmdd の日付は、その種類。文字列は決めない", () => {
    expect(paramTypeForColumn(num("QTY"))).toBe("number");
    expect(
      paramTypeForColumn({
        name: "SHIP_DATE",
        type: { kind: "datetime", hasTime: false },
      }),
    ).toBe("date");
    expect(
      paramTypeForColumn({
        ...str("ORDER_YMD"),
        semantic: { kind: "date", format: "yyyymmdd" },
      }),
    ).toBe("ymd");
    expect(paramTypeForColumn(str("ORDER_NO"))).toBeUndefined();
    expect(
      paramTypeForColumn({
        name: "IMG",
        type: { kind: "other", dbTypeName: "varbinary" },
      }),
    ).toBeUndefined();
  });
});
