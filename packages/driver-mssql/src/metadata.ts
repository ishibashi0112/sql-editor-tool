// スキーマ・テーブル・列の情報を取る SQL と、DB の型 → ColumnType の対応。
// SQL Server 2012 で使えるカタログビュー（sys.*）だけを使う。見えるのは参照権限のあるものだけ

import type { ColumnType } from "@sql-editor-tool/core";
import { EXACT_DIGITS } from "@sql-editor-tool/host";

/** テーブルかビューがあるスキーマ */
export const LIST_SCHEMAS_SQL = `SELECT s.name
FROM sys.schemas s
WHERE EXISTS (
  SELECT 1 FROM sys.objects o
  WHERE o.schema_id = s.schema_id AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
)
ORDER BY s.name`;

/** @schema のテーブルとビュー。type は 'U '（テーブル）か 'V '（ビュー） */
export const LIST_OBJECTS_SQL = `SELECT o.name, o.type
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @schema AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
ORDER BY o.name`;

/**
 * @schema.@name の列。型は別名の型（CREATE TYPE）でも元の型の名前にする（TYPE_NAME(system_type_id)）。
 * max_length は nvarchar / nchar ではバイト数（文字数の 2 倍）、MAX なら -1
 */
export const DESCRIBE_COLUMNS_SQL = `SELECT c.name, TYPE_NAME(c.system_type_id) AS type_name, c.max_length, c.precision, c.scale
FROM sys.columns c
JOIN sys.objects o ON o.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @schema AND o.name = @name AND o.type IN ('U', 'V')
ORDER BY c.column_id`;

/** すべてのスキーマのテーブルとビュー（テーブル検索用） */
export const LIST_ALL_OBJECTS_SQL = `SELECT s.name, o.name, o.type
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
ORDER BY s.name, o.name`;

/** @schema.@name の主キーの列（キーの順） */
export const PRIMARY_KEY_SQL = `SELECT c.name
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE s.name = @schema AND o.name = @name AND i.is_primary_key = 1
ORDER BY ic.key_ordinal`;

/** tedious の結果の列のメタデータ（使う部分だけ） */
export type ResultMetadata = {
  type: { name: string };
  dataLength?: number | undefined;
  precision?: number | undefined;
  scale?: number | undefined;
};

/** 整数型の N 版（IntN）は、バイト数で型が決まる */
const INT_N_PRECISION: Record<number, number> = { 1: 3, 2: 5, 4: 10, 8: 19 };

/**
 * 結果の列の型（レポートの結果に使う）。describeTable の toColumnType と同じ対応にする。
 * 結果の値は変換できないので、16 桁以上の decimal も asText にはしない（O-14）
 */
export function resultColumnType(meta: ResultMetadata): ColumnType {
  const length = meta.dataLength ?? 0;
  const precision = meta.precision ?? 0;
  const scale = meta.scale ?? 0;
  const as = (typeName: string, maxLength: number, p = precision, s = scale) =>
    toColumnType({ typeName, maxLength, precision: p, scale: s });
  switch (meta.type.name) {
    case "VarChar":
    case "Char":
      // MAX は 65535 で届く
      return as(meta.type.name, length > 8000 ? -1 : length);
    case "NVarChar":
    case "NChar":
      return as(meta.type.name, length > 8000 ? -1 : length);
    case "IntN":
      return {
        kind: "number",
        precision: INT_N_PRECISION[length] ?? 19,
        scale: 0,
      };
    case "TinyInt":
      return { kind: "number", precision: 3, scale: 0 };
    case "SmallInt":
      return { kind: "number", precision: 5, scale: 0 };
    case "Int":
      return { kind: "number", precision: 10, scale: 0 };
    case "BigInt":
      return { kind: "number", precision: 19, scale: 0 };
    case "Decimal":
    case "Numeric":
    case "DecimalN":
    case "NumericN":
      return { kind: "number", precision, scale };
    case "Money":
    case "MoneyN":
      return { kind: "number", precision: length === 4 ? 10 : 19, scale: 4 };
    case "SmallMoney":
      return { kind: "number", precision: 10, scale: 4 };
    case "Bit":
    case "BitN":
      return as("bit", 1);
    case "Float":
    case "Real":
    case "FloatN":
      return as("float", length);
    case "Date":
      return as("date", 3);
    case "DateTime":
    case "DateTimeN":
    case "SmallDateTime":
    case "DateTime2":
      return as("datetime", 8);
    default:
      return as(meta.type.name.toLowerCase(), length);
  }
}

export type SysColumn = {
  typeName: string;
  maxLength: number;
  precision: number;
  scale: number;
};

/** sys.columns の型 → ColumnType */
export function toColumnType(column: SysColumn): ColumnType {
  const { maxLength, precision, scale } = column;
  const typeName = column.typeName.toLowerCase();
  switch (typeName) {
    case "char":
    case "varchar":
      return {
        kind: "string",
        unicode: false,
        fixedLength: typeName === "char",
        length: maxLength === -1 ? null : maxLength,
      };
    case "nchar":
    case "nvarchar":
      return {
        kind: "string",
        unicode: true,
        fixedLength: typeName === "nchar",
        length: maxLength === -1 ? null : maxLength / 2,
      };
    case "decimal":
    case "numeric":
      // tedious は decimal を JavaScript の数値で読むので、16 桁以上は SELECT で文字列にして取る（§13.1）
      return precision > EXACT_DIGITS
        ? { kind: "number", precision, scale, asText: true }
        : { kind: "number", precision, scale };
    // bigint は tedious が文字列で返すので、桁が落ちない
    case "bigint":
    case "int":
    case "smallint":
    case "tinyint":
    case "money":
    case "smallmoney":
      return { kind: "number", precision, scale };
    // 0 / 1 として扱う（values.ts）
    case "bit":
      return { kind: "number", precision: 1, scale: 0 };
    case "float":
    case "real":
      return { kind: "number", precision: null, scale: null };
    case "date":
      return { kind: "datetime", hasTime: false };
    case "datetime":
    case "datetime2":
    case "smalldatetime":
      return { kind: "datetime", hasTime: true };
    // text / ntext は = で比べられない。time / datetimeoffset / uniqueidentifier / バイナリなども、条件では扱わない
    default:
      return { kind: "other", dbTypeName: typeName };
  }
}
