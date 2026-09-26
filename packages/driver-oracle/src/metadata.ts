// スキーマ・テーブル・列の情報を取る SQL と、DB の型 → ColumnType の対応。
// ALL_* のビューを使うので、見えるのは参照権限のあるものだけ

import type { ColumnType } from "@sql-editor-tool/core";

/** テーブルかビューがあるスキーマ。Oracle が管理するスキーマ（SYS など）は除く */
export const LIST_SCHEMAS_SQL = `SELECT USERNAME
FROM ALL_USERS
WHERE ORACLE_MAINTAINED = 'N'
  AND USERNAME IN (SELECT OWNER FROM ALL_TABLES UNION SELECT OWNER FROM ALL_VIEWS)
ORDER BY USERNAME`;

/**
 * :owner のテーブル（'T'）とビュー（'V'）。
 * 入れ子の表、索引の二次表、ごみ箱の表、索引構成表のオーバーフロー領域などの内部の表は除く
 */
export const LIST_OBJECTS_SQL = `SELECT TABLE_NAME, 'T'
FROM ALL_TABLES
WHERE OWNER = :owner
  AND NESTED = 'NO' AND SECONDARY = 'N' AND DROPPED = 'NO'
  AND (IOT_TYPE IS NULL OR IOT_TYPE = 'IOT')
UNION ALL
SELECT VIEW_NAME, 'V'
FROM ALL_VIEWS
WHERE OWNER = :owner
ORDER BY 1`;

/** Oracle が管理するスキーマを除いた、すべてのテーブル（'T'）とビュー（'V'）。テーブル検索用 */
export const LIST_ALL_OBJECTS_SQL = `SELECT OWNER, TABLE_NAME, 'T'
FROM ALL_TABLES
WHERE NESTED = 'NO' AND SECONDARY = 'N' AND DROPPED = 'NO'
  AND (IOT_TYPE IS NULL OR IOT_TYPE = 'IOT')
  AND OWNER IN (SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'N')
UNION ALL
SELECT OWNER, VIEW_NAME, 'V'
FROM ALL_VIEWS
WHERE OWNER IN (SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'N')
ORDER BY 1, 2`;

/** :owner.:name の列（隠し列は含まない） */
export const DESCRIBE_COLUMNS_SQL = `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, CHAR_LENGTH, CHAR_USED, DATA_PRECISION, DATA_SCALE
FROM ALL_TAB_COLUMNS
WHERE OWNER = :owner AND TABLE_NAME = :name
ORDER BY COLUMN_ID`;

/** :owner.:name の主キーの列（キーの順） */
export const PRIMARY_KEY_SQL = `SELECT cc.COLUMN_NAME
FROM ALL_CONSTRAINTS c
JOIN ALL_CONS_COLUMNS cc
  ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND cc.TABLE_NAME = c.TABLE_NAME
WHERE c.OWNER = :owner AND c.TABLE_NAME = :name AND c.CONSTRAINT_TYPE = 'P'
ORDER BY cc.POSITION`;

export type TabColumn = {
  dataType: string;
  /** バイト数 */
  dataLength: number;
  /** 文字数 */
  charLength: number;
  /** 長さの単位。'B'（バイト）か 'C'（文字）。文字列以外は null */
  charUsed: string | null;
  precision: number | null;
  scale: number | null;
};

/** ALL_TAB_COLUMNS の型 → ColumnType */
export function toColumnType(column: TabColumn): ColumnType {
  const dataType = column.dataType.toUpperCase();
  switch (dataType) {
    case "VARCHAR2":
    case "CHAR":
      return {
        kind: "string",
        unicode: false,
        fixedLength: dataType === "CHAR",
        // NLS_LENGTH_SEMANTICS = BYTE の DB では、宣言した長さはバイト数（§13.2）
        length: column.charUsed === "C" ? column.charLength : column.dataLength,
      };
    case "NVARCHAR2":
    case "NCHAR":
      return {
        kind: "string",
        unicode: true,
        fixedLength: dataType === "NCHAR",
        length: column.charLength,
      };
    // 精度の指定がない NUMBER は precision が null。値は取得時に文字列にする（values.ts）
    case "NUMBER":
      return {
        kind: "number",
        precision: column.precision,
        scale: column.scale,
      };
    case "FLOAT":
    case "BINARY_FLOAT":
    case "BINARY_DOUBLE":
      return { kind: "number", precision: null, scale: null };
    // Oracle の DATE は時刻を持つ（時刻を使っているかは O-01）
    case "DATE":
      return { kind: "datetime", hasTime: true };
  }
  if (/^TIMESTAMP\(\d\)$/.test(dataType)) {
    return { kind: "datetime", hasTime: true };
  }
  // CLOB は = で比べられない。BLOB・RAW・時差つきの TIMESTAMP・INTERVAL なども、条件では扱わない
  return { kind: "other", dbTypeName: dataType };
}
