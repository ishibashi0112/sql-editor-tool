import type { ConditionColumn } from "@sql-editor-tool/host";
import { describe, expect, test } from "vitest";
import {
  insertAtCursor,
  insertColumn,
  suggestColumns,
  wordBefore,
} from "./conditionSuggest";

// 架空の列
const columns: ConditionColumn[] = [
  { name: "ORDER_NO", logicalName: "受注番号", typeLabel: "文字 10" },
  { name: "ORDER_YMD", logicalName: "受注日", typeLabel: "日付（yyyymmdd）" },
  { name: "CUST_CD", logicalName: "得意先コード", typeLabel: "文字 8" },
  { name: "QTY", logicalName: "数量", typeLabel: "数値" },
  { name: "USER", typeLabel: "文字 20" },
  { name: "Note", typeLabel: "文字" },
];

describe("wordBefore", () => {
  test("カーソルの前の打ちかけの語。文字列・コメント・[名前] の中は null", () => {
    expect(wordBefore("mssql", "ord", 3)).toEqual({ start: 0, word: "ord" });
    expect(wordBefore("mssql", "QTY > 0 AND 受注", 14)).toEqual({
      start: 12,
      word: "受注",
    });
    expect(wordBefore("mssql", "QTY = ", 6)).toEqual({ start: 6, word: "" });
    expect(wordBefore("mssql", "CUST_CD = 'ord", 14)).toBeNull();
    expect(wordBefore("mssql", "CUST_CD = 'x' AND ord", 21)).toEqual({
      start: 18,
      word: "ord",
    });
    expect(wordBefore("mssql", "-- ord", 6)).toBeNull();
    expect(wordBefore("mssql", "[ord", 4)).toBeNull();
    expect(wordBefore("mssql", "o.ord", 5)).toBeNull();
    expect(wordBefore("mssql", "QTY > 10", 8)).toBeNull();
  });
});

describe("suggestColumns", () => {
  test("名前の先頭 → 論理名の先頭 → 途中の順。打ち終わった名前だけなら出さない", () => {
    const names = (word: string, all = false) =>
      suggestColumns(columns, word, { all }).map((c) => c.name);
    expect(names("or")).toEqual(["ORDER_NO", "ORDER_YMD"]);
    expect(names("受注")).toEqual(["ORDER_NO", "ORDER_YMD"]);
    expect(names("コード")).toEqual(["CUST_CD"]);
    expect(names("cd")).toEqual(["CUST_CD"]);
    expect(names("qty")).toEqual([]);
    expect(names("qty", true)).toEqual(["QTY"]);
    expect(names("")).toEqual([]);
    expect(names("", true)).toHaveLength(6);
  });
});

describe("insertColumn", () => {
  test("語を列名に置き換える。予約語や、Oracle の小文字を含む名前は囲む", () => {
    expect(
      insertColumn("mssql", "QTY > 0 AND 受注", 12, 14, "ORDER_YMD"),
    ).toEqual({ text: "QTY > 0 AND ORDER_YMD", caret: 21 });
    expect(insertColumn("mssql", "us = 1", 0, 2, "USER")).toEqual({
      text: "[USER] = 1",
      caret: 6,
    });
    expect(insertColumn("oracle", "no", 0, 2, "Note").text).toBe('"Note"');
    expect(insertColumn("mssql", "no", 0, 2, "Note").text).toBe("Note");
  });
});

describe("insertAtCursor", () => {
  test("カーソルの位置に入れ、語や値に付くときは空白を挟む。範囲を選んでいれば置き換える", () => {
    expect(insertAtCursor("mssql", "", 0, 0, "ORDER_YMD")).toEqual({
      text: "ORDER_YMD",
      caret: 9,
    });
    expect(insertAtCursor("mssql", "QTY > 0 AND", 11, 11, "CUST_CD")).toEqual({
      text: "QTY > 0 AND CUST_CD",
      caret: 19,
    });
    expect(insertAtCursor("mssql", "= '01'", 0, 0, "WH_CD")).toEqual({
      text: "WH_CD = '01'",
      caret: 5,
    });
    expect(insertAtCursor("mssql", "(QTY) = 1", 1, 4, "USER").text).toBe(
      "([USER]) = 1",
    );
  });
});
