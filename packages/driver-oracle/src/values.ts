// node-oracledb の値 → セルの値、バインド変数 → node-oracledb のバインド（docs/handover.md §6）

import type { BoundParam } from "@sql-editor-tool/core";
import {
  type CellValue,
  EXACT_DIGITS,
  formatBinary,
  formatDateTime,
  toPlainDecimal,
} from "@sql-editor-tool/host";
import oracledb from "oracledb";

/**
 * 取得するときの型の指定（execute の fetchTypeHandler）。
 * - 精度の指定がない NUMBER と 16 桁以上の NUMBER は、JavaScript の数値にすると下の桁が狂うので文字列で取る（§13.2）
 * - CLOB は文字列で取る。BLOB は中身を取らない（toCellValue で大きさだけ表示する）
 */
export function fetchTypeHandler(
  metadata: oracledb.Metadata<unknown>,
): oracledb.FetchTypeResponse | undefined {
  switch (metadata.dbType) {
    case oracledb.DB_TYPE_NUMBER: {
      const precision = metadata.precision ?? 0;
      return precision === 0 || precision > EXACT_DIGITS
        ? { type: oracledb.STRING, converter: normalizeNumberText }
        : undefined;
    }
    case oracledb.DB_TYPE_CLOB:
    case oracledb.DB_TYPE_NCLOB:
      return { type: oracledb.STRING };
    default:
      return undefined;
  }
}

/** Thin モードは 0.5 を '.5' と返すので、先頭に 0 を補う */
export function normalizeNumberText(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/^(-?)\./, "$10.") : value;
}

/** node-oracledb の LOB（BLOB）。中身は読まない */
type LobLike = { type: unknown; length: number; destroy(): void };

function isLob(value: object): value is LobLike {
  return (
    "length" in value &&
    "type" in value &&
    typeof (value as { destroy?: unknown }).destroy === "function"
  );
}

/**
 * 結果の値をセルの値にする。
 * DATE / TIMESTAMP は、node-oracledb が DB の値をそのまま Node のローカル時刻として Date にしたものなので、ローカル時刻で読む
 */
export function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) {
    return formatDateTime(
      {
        year: value.getFullYear(),
        month: value.getMonth() + 1,
        day: value.getDate(),
        hour: value.getHours(),
        minute: value.getMinutes(),
        second: value.getSeconds(),
        fraction: value.getMilliseconds() * 10000,
      },
      true,
    );
  }
  if (value instanceof Uint8Array) return formatBinary(value);
  if (typeof value === "object" && isLob(value)) {
    // 表示の対象外（§13.2）。ロケーターはすぐに解放する
    value.destroy();
    return `（BLOB ${value.length} バイト）`;
  }
  // INTERVAL など
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

/**
 * バインド変数を node-oracledb の形にする。
 * 数値は 15 桁以内なら NUMBER、それより多い桁は文字列で送り、Oracle が NUMBER に変換する（桁を落とさない）
 */
export function toBinds(
  params: readonly BoundParam[],
): Record<string, oracledb.BindParameter> {
  return Object.fromEntries(params.map((param) => [param.name, toBind(param)]));
}

function toBind(param: BoundParam): oracledb.BindParameter {
  const { name, value, type } = param;
  switch (type.kind) {
    case "string":
      return {
        type: type.unicode
          ? oracledb.DB_TYPE_NVARCHAR
          : oracledb.DB_TYPE_VARCHAR,
        val: String(value),
      };
    case "integer":
    case "number": {
      const decimal = toPlainDecimal(value);
      if (!decimal) {
        throw new Error(`バインド変数 ${name} の値が数値ではありません`);
      }
      const digits = Math.max(decimal.integerDigits + decimal.scale, 1);
      return digits <= EXACT_DIGITS
        ? { type: oracledb.DB_TYPE_NUMBER, val: Number(decimal.text) }
        : { type: oracledb.DB_TYPE_VARCHAR, val: decimal.text };
    }
  }
}
