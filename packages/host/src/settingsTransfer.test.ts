import { describe, expect, test } from "vitest";
import {
  commonFolder,
  fileUris,
  parseSettingsExport,
  remapFolders,
  SETTINGS_FORMAT,
  type SettingsExport,
} from "./settingsTransfer";

// パスとファイル名は架空
const exported: SettingsExport = {
  format: SETTINGS_FORMAT,
  version: 1,
  exportedAt: "2026-09-27T00:00:00.000Z",
  connections: [{ name: "基幹", driver: "mssql", host: "db", port: 1433 }],
  fileConnections: {
    "file:///c%3A/Users/a/sql/%E5%8F%97%E6%B3%A8.sql": "基幹",
    "untitled:Untitled-1": "基幹",
  },
  paramSettings: {
    "file:///c%3A/Users/a/sql/bi/%E5%9C%A8%E5%BA%AB.sql": {
      開始日: { type: "ymd" },
    },
  },
  formValues: { "file:///C%3A/Users/a/sql/x.sql": { 開始日: "20260901" } },
  tableSettings: { '["基幹","dbo","T"]': { keyColumns: ["A"] } },
  settings: { maxRows: 50000 },
};

describe("parseSettingsExport", () => {
  test("書き出したものをそのまま読める。形の違う項目は捨てる", () => {
    expect(parseSettingsExport(JSON.parse(JSON.stringify(exported)))).toEqual(
      exported,
    );
    expect(
      parseSettingsExport({
        format: SETTINGS_FORMAT,
        version: 1,
        connections: [{ name: "x", driver: "db2" }, "x", { driver: "demo" }],
        fileConnections: { a: 1, b: "接続" },
      }),
    ).toMatchObject({ connections: [], fileConnections: { b: "接続" } });
  });

  test("ほかのファイルや、新しい版の設定は分かるメッセージで止める", () => {
    expect(() => parseSettingsExport({ a: 1 })).toThrow(
      "SQL Editor Tool の設定のファイルではありません",
    );
    expect(() =>
      parseSettingsExport({ format: SETTINGS_FORMAT, version: 99 }),
    ).toThrow("新しい版");
  });
});

describe("commonFolder と remapFolders", () => {
  test("file: の URI のいちばん深い共通のフォルダ（大文字小文字は区別しない）", () => {
    expect(fileUris(exported)).toHaveLength(3);
    expect(commonFolder(fileUris(exported))).toBe("file:///c%3A/Users/a/sql");
    // ドライブの直下より浅いときは付け替えない
    expect(
      commonFolder(["file:///c%3A/a.sql", "file:///d%3A/work/b.sql"]),
    ).toBeNull();
    expect(commonFolder([])).toBeNull();
  });

  test("共通のフォルダの下のものを、選んだフォルダの下に付け替える", () => {
    const moved = remapFolders(
      exported,
      "file:///c%3A/Users/a/sql",
      "file:///d%3A/%E4%BD%9C%E6%A5%AD",
    );
    expect(Object.keys(moved.fileConnections)).toEqual([
      "file:///d%3A/%E4%BD%9C%E6%A5%AD/%E5%8F%97%E6%B3%A8.sql",
      "untitled:Untitled-1",
    ]);
    expect(Object.keys(moved.paramSettings)).toEqual([
      "file:///d%3A/%E4%BD%9C%E6%A5%AD/bi/%E5%9C%A8%E5%BA%AB.sql",
    ]);
    expect(Object.keys(moved.formValues)).toEqual([
      "file:///d%3A/%E4%BD%9C%E6%A5%AD/x.sql",
    ]);
    expect(moved.tableSettings).toEqual(exported.tableSettings);
  });
});
