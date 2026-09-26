// ドライバが共通で使う値の変換。DB の値 → 画面のセルの値（CellValue）と、バインドする数値の桁の判定

export type DateTimeParts = {
  year: number;
  /** 1〜12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 秒の小数部。100 ナノ秒単位（0〜9999999） */
  fraction: number;
};

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** 'HH:mm:ss'。秒の小数部は 0 でなければ付ける（末尾の 0 は除く） */
export function formatTime(parts: DateTimeParts): string {
  const time = `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}`;
  if (parts.fraction === 0) return time;
  return `${time}.${pad(parts.fraction, 7).replace(/0+$/, "")}`;
}

/** 'YYYY-MM-DD'、時刻を含めるなら 'YYYY-MM-DD HH:mm:ss'。時刻は 0 時でも付ける（列の型で表示をそろえる） */
export function formatDateTime(
  parts: DateTimeParts,
  withTime: boolean,
): string {
  const date = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
  return withTime ? `${date} ${formatTime(parts)}` : date;
}

const BINARY_PREVIEW_BYTES = 64;

/** バイナリは '0x' で始まる 16 進にする。長いものは先頭だけ */
export function formatBinary(bytes: Uint8Array): string {
  const head = Array.from(bytes.subarray(0, BINARY_PREVIEW_BYTES), (b) =>
    b.toString(16).toUpperCase().padStart(2, "0"),
  ).join("");
  return bytes.length > BINARY_PREVIEW_BYTES
    ? `0x${head}…（${bytes.length} バイト）`
    : `0x${head}`;
}

/** 10 進の数値を指数表記なしの形にしたもの */
export type PlainDecimal = {
  /** 例：'-12.5'、'0.05'、'1500'。先頭の余分な 0 と、小数部の末尾の 0 は除く */
  text: string;
  /** 整数部の桁数（0.05 なら 0） */
  integerDigits: number;
  /** 小数部の桁数（末尾の 0 を除く） */
  scale: number;
};

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * 数値（または数値の文字列）を指数表記なしの 10 進にする。数値でなければ null。
 * バインドする値を JavaScript の数値で正確に表せるか（桁数）を判定するために使う
 */
export function toPlainDecimal(value: number | string): PlainDecimal | null {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  // 数値は最短の 10 進表記（String）から作る。toFixed などで桁を足すと、表せない下の桁が出てくる
  const match = DECIMAL.exec(String(value).trim());
  if (!match) return null;
  const [, sign = "", intPart = "", fracPart = "", exponent = "0"] = match;
  if (intPart === "" && fracPart === "") return null;
  // 小数点の位置を指数の分だけずらす
  let digits = intPart + fracPart;
  let point = intPart.length + Number(exponent);
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  } else if (point > digits.length) {
    digits += "0".repeat(point - digits.length);
  }
  const integer = digits.slice(0, point).replace(/^0+/, "");
  const fraction = digits.slice(point).replace(/0+$/, "");
  const isZero = integer === "" && fraction === "";
  const body = `${integer || "0"}${fraction ? `.${fraction}` : ""}`;
  return {
    text: sign === "-" && !isZero ? `-${body}` : body,
    integerDigits: integer.length,
    scale: fraction.length,
  };
}

/**
 * JavaScript の数値（倍精度）に変換しても値が変わらない桁数。
 * 15 桁以内の 10 進数は、数値にして 10 進に戻しても同じになる
 */
export const EXACT_DIGITS = 15;
