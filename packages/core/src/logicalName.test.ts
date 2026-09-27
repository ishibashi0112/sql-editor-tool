import { describe, expect, it } from "vitest";
import { shortLogicalName, splitDbComment } from "./logicalName";

describe("splitDbComment", () => {
  it("区切りがなければ全体が論理名", () => {
    expect(splitDbComment("受注日")).toEqual({ logicalName: "受注日" });
  });

  it("最初の : で論理名とコメントに分ける（A5:SQL Mk-2 と同じ）", () => {
    expect(splitDbComment("受注日:受注を受けた日")).toEqual({
      logicalName: "受注日",
      comment: "受注を受けた日",
    });
    // 2 つ目以降の : はコメントの一部
    expect(splitDbComment("区分:1:通常 2:至急")).toEqual({
      logicalName: "区分",
      comment: "1:通常 2:至急",
    });
  });

  it("タブ・改行でも分ける（CRLF も）", () => {
    expect(splitDbComment("得意先コード\t得意先マスタのキー")).toEqual({
      logicalName: "得意先コード",
      comment: "得意先マスタのキー",
    });
    expect(splitDbComment("出荷日\r\nyyyymmdd\r\n未出荷は空")).toEqual({
      logicalName: "出荷日",
      comment: "yyyymmdd\r\n未出荷は空",
    });
  });

  it("全角の ： では分けない（A5 の既定と同じ）", () => {
    expect(splitDbComment("受注日：受注を受けた日")).toEqual({
      logicalName: "受注日：受注を受けた日",
    });
  });

  it("空・NULL・空白だけなら何もない。論理名が空ならコメントだけ", () => {
    expect(splitDbComment(null)).toEqual({});
    expect(splitDbComment(undefined)).toEqual({});
    expect(splitDbComment("")).toEqual({});
    expect(splitDbComment("  ")).toEqual({});
    expect(splitDbComment(":説明だけ")).toEqual({ comment: "説明だけ" });
    expect(splitDbComment(" 数量 : ")).toEqual({ logicalName: "数量" });
  });
});

describe("shortLogicalName", () => {
  it("24 文字を超えたら省略する", () => {
    expect(shortLogicalName("受注日")).toBe("受注日");
    const long = "あ".repeat(30);
    expect(shortLogicalName(long)).toBe(`${"あ".repeat(23)}…`);
    expect(shortLogicalName("あ".repeat(24))).toBe("あ".repeat(24));
  });
});
