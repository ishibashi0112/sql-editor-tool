// tedious の値 → セルの値、バインド変数 → tedious のパラメータ（docs/handover.md §6）

import type { BoundParam } from "@sql-editor-tool/core";
import {
  type CellValue,
  type DateTimeParts,
  EXACT_DIGITS,
  formatBinary,
  formatDateTime,
  formatTime,
  toPlainDecimal,
} from "@sql-editor-tool/host";
import { TYPES } from "tedious";

/** tedious の型（DataType はパッケージの入口から export されていない） */
type DataType = (typeof TYPES)[keyof typeof TYPES];

/**
 * 結果の値をセルの値にする。typeName は列のメタデータの型名（tedious の DataType.name）。
 * 日付・時刻は、tedious が useUTC（既定）で DB の値をそのまま UTC として Date にしたものなので、UTC で読む
 */
export function toCellValue(value: unknown, typeName: string): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  // bit
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return formatDate(value, typeName);
  if (value instanceof Uint8Array) return formatBinary(value);
  return String(value);
}

function formatDate(date: Date, typeName: string): string {
  const parts = utcParts(date);
  switch (typeName) {
    case "Date":
      return formatDateTime(parts, false);
    case "Time":
      return formatTime(parts);
    // 元の時差は tedious が受け取った時点で失われるので、UTC で表す
    case "DateTimeOffset":
      return `${formatDateTime(parts, true)} +00:00`;
    default:
      return formatDateTime(parts, true);
  }
}

function utcParts(date: Date): DateTimeParts {
  // datetime2 / time のミリ秒より下の桁は、tedious が nanosecondsDelta（秒単位）に入れている
  const delta = (date as Date & { nanosecondsDelta?: number }).nanosecondsDelta;
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    fraction:
      date.getUTCMilliseconds() * 10000 + Math.round((delta ?? 0) * 1e7),
  };
}

export type TediousParam = {
  name: string;
  type: DataType;
  value: unknown;
  options?: { precision: number; scale: number };
};

const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

export function toTediousParam(param: BoundParam): TediousParam {
  const { name, value, type } = param;
  switch (type.kind) {
    case "string":
      // 列が varchar のときに nvarchar で送ると、列の側が変換されて索引が効かなくなることがある（§6）
      return {
        name,
        type: type.unicode ? TYPES.NVarChar : TYPES.VarChar,
        value: value === null ? null : String(value),
      };
    case "integer":
    case "number":
      // 空欄（NULL）は型を問わないので int で送る
      return value === null
        ? { name, type: TYPES.Int, value: null }
        : numberParam(name, value);
  }
}

/**
 * 数値は桁数に応じて型を選ぶ。
 * - 整数：int か bigint（bigint は文字列のまま送れるので、19 桁まで正確）
 * - 15 桁以内：decimal(p, s)（tedious は decimal を JavaScript の数値で送るので、15 桁までしか正確でない）
 * - それより多い桁：varchar で送り、SQL Server が列の型に変換する（比べる列が numeric なら、その精度に丸められる）
 */
function numberParam(name: string, value: string | number): TediousParam {
  const decimal = toPlainDecimal(value);
  if (!decimal)
    throw new Error(`バインド変数 ${name} の値が数値ではありません`);
  const { text, integerDigits, scale } = decimal;
  if (scale === 0) {
    const n = BigInt(text);
    if (n >= INT_MIN && n <= INT_MAX)
      return { name, type: TYPES.Int, value: Number(n) };
    if (n >= BIGINT_MIN && n <= BIGINT_MAX)
      return { name, type: TYPES.BigInt, value: text };
  }
  const precision = Math.max(integerDigits + scale, 1);
  if (precision <= EXACT_DIGITS) {
    return {
      name,
      type: TYPES.Decimal,
      value: Number(text),
      options: { precision, scale },
    };
  }
  return { name, type: TYPES.VarChar, value: text };
}
