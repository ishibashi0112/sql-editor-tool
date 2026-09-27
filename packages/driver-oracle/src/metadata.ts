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
 * :owner のテーブル（'T'）とビュー（'V'）と、そのコメント（COMMENT ON TABLE。論理名のもと、D-40）。
 * 入れ子の表、索引の二次表、ごみ箱の表、索引構成表のオーバーフロー領域などの内部の表は除く
 */
export const LIST_OBJECTS_SQL = `SELECT t.TABLE_NAME, 'T', c.COMMENTS
FROM ALL_TABLES t
LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
WHERE t.OWNER = :owner
  AND t.NESTED = 'NO' AND t.SECONDARY = 'N' AND t.DROPPED = 'NO'
  AND (t.IOT_TYPE IS NULL OR t.IOT_TYPE = 'IOT')
UNION ALL
SELECT v.VIEW_NAME, 'V', c.COMMENTS
FROM ALL_VIEWS v
LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = v.OWNER AND c.TABLE_NAME = v.VIEW_NAME
WHERE v.OWNER = :owner
ORDER BY 1`;

/** Oracle が管理するスキーマを除いた、すべてのテーブル（'T'）とビュー（'V'）とコメント。テーブル検索用 */
export const LIST_ALL_OBJECTS_SQL = `SELECT t.OWNER, t.TABLE_NAME, 'T', c.COMMENTS
FROM ALL_TABLES t
LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = t.OWNER AND c.TABLE_NAME = t.TABLE_NAME
WHERE t.NESTED = 'NO' AND t.SECONDARY = 'N' AND t.DROPPED = 'NO'
  AND (t.IOT_TYPE IS NULL OR t.IOT_TYPE = 'IOT')
  AND t.OWNER IN (SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'N')
UNION ALL
SELECT v.OWNER, v.VIEW_NAME, 'V', c.COMMENTS
FROM ALL_VIEWS v
LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = v.OWNER AND c.TABLE_NAME = v.VIEW_NAME
WHERE v.OWNER IN (SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'N')
ORDER BY 1, 2`;

/** :owner.:name の列（隠し列は含まない）と、そのコメント（COMMENT ON COLUMN） */
export const DESCRIBE_COLUMNS_SQL = `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.CHAR_LENGTH, c.CHAR_USED, c.DATA_PRECISION, c.DATA_SCALE, cc.COMMENTS
FROM ALL_TAB_COLUMNS c
LEFT JOIN ALL_COL_COMMENTS cc
  ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
WHERE c.OWNER = :owner AND c.TABLE_NAME = :name
ORDER BY c.COLUMN_ID`;

/** :owner.:name の主キーの列（キーの順） */
export const PRIMARY_KEY_SQL = `SELECT cc.COLUMN_NAME
FROM ALL_CONSTRAINTS c
JOIN ALL_CONS_COLUMNS cc
  ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND cc.TABLE_NAME = c.TABLE_NAME
WHERE c.OWNER = :owner AND c.TABLE_NAME = :name AND c.CONSTRAINT_TYPE = 'P'
ORDER BY cc.POSITION`;

/** node-oracledb の結果の列のメタデータ（使う部分だけ） */
export type ResultMetadata = {
  dbTypeName?: string | undefined;
  byteSize?: number | undefined;
  precision?: number | undefined;
  scale?: number | undefined;
};

/** 結果の列の型（レポートの結果に使う）。describeTable の toColumnType と同じ対応にする */
export function resultColumnType(meta: ResultMetadata): ColumnType {
  const dataType = (meta.dbTypeName ?? "").toUpperCase();
  const bytes = meta.byteSize ?? 0;
  // 精度の指定がない NUMBER は precision 0、scale -127 で届く
  const precision = meta.precision ? meta.precision : null;
  const scale =
    meta.scale === undefined || meta.scale === -127 ? null : meta.scale;
  return toColumnType({
    dataType,
    dataLength: bytes,
    // 各国語文字（AL16UTF16）は 1 文字 2 バイト
    charLength: dataType.startsWith("N") ? bytes / 2 : bytes,
    charUsed: "B",
    precision,
    scale: precision === null ? null : scale,
  });
}

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
  if (/^TIMESTAMP(\(\d\))?$/.test(dataType)) {
    return { kind: "datetime", hasTime: true };
  }
  // CLOB は = で比べられない。BLOB・RAW・時差つきの TIMESTAMP・INTERVAL なども、条件では扱わない
  return { kind: "other", dbTypeName: dataType };
}
