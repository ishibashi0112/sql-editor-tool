// 相対の日付（D-32）。レポートの日付の入力欄の既定値に「今日」「月初-1か月」のように書く。
// 基準（今日・月初・月末・年初・年末・年度初・年度末）に、±N日・±Nか月・±N年を付けられる。
// 年度は 4 月始まり。か月・年の増減を先に当てて基準の日を決め、そのあと日の増減を当てる

import { normalizeDateKey, ymdToDateKey } from "./dateKey";

type Base = "今日" | "月初" | "月末" | "年初" | "年末" | "年度初" | "年度末";

const BASES: readonly Base[] = [
  "今日",
  "月初",
  "月末",
  "年初",
  "年末",
  "年度初",
  "年度末",
];

/** よく使うものの別名。基準と増減に置き換える */
const ALIASES: Record<string, string> = {
  本日: "今日",
  昨日: "今日-1日",
  明日: "今日+1日",
  今月初: "月初",
  今月末: "月末",
  前月初: "月初-1か月",
  前月末: "月末-1か月",
  翌月初: "月初+1か月",
  翌月末: "月末+1か月",
};

const OFFSET = /^([+-])(\d{1,4})(日|か月|ヶ月|ケ月|カ月|ヵ月|箇月|月|年)/;

type Offsets = { days: number; months: number };

/** 全角の数字・記号と空白をそろえる（「今日－７日」「月初 - 1 か月」も読めるように） */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[−‐‑‒–—﹣]/g, "-")
    .replace(/\s+/g, "");
}

/** 基準と増減に分ける。相対の日付でなければ null */
function parse(text: string): { base: Base; offsets: Offsets } | null {
  let rest = normalize(text);
  const alias = Object.keys(ALIASES)
    .filter((name) => rest.startsWith(name))
    .sort((a, b) => b.length - a.length)[0];
  if (alias !== undefined) {
    rest = (ALIASES[alias] ?? "") + rest.slice(alias.length);
  }
  const base = [...BASES]
    .sort((a, b) => b.length - a.length)
    .find((name) => rest.startsWith(name));
  if (base === undefined) return null;
  rest = rest.slice(base.length);
  const offsets: Offsets = { days: 0, months: 0 };
  while (rest) {
    const m = OFFSET.exec(rest);
    if (!m) return null;
    const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
    if (m[3] === "日") offsets.days += n;
    else if (m[3] === "年") offsets.months += n * 12;
    else offsets.months += n;
    rest = rest.slice(m[0].length);
  }
  return { base, offsets };
}

/** 「今日」「月初-1か月」などの相対の日付か */
export function isRelativeDate(text: string): boolean {
  return parse(text) !== null;
}

/** 相対の日付を、now（ローカル時刻）を基準に 'YYYY-MM-DD' にする。相対の日付でなければ null */
export function resolveRelativeDate(text: string, now: Date): string | null {
  const parsed = parse(text);
  if (!parsed) return null;
  const { base, offsets } = parsed;
  const year = now.getFullYear();
  const month = now.getMonth(); // 0 始まり
  const fiscalYear = month >= 3 ? year : year - 1;
  // 基準の年月（か月・年の増減を当てる前）と、その月の中の日
  const [baseYear, baseMonth, day]: [
    number,
    number,
    "first" | "last" | number,
  ] =
    base === "今日"
      ? [year, month, now.getDate()]
      : base === "月初"
        ? [year, month, "first"]
        : base === "月末"
          ? [year, month, "last"]
          : base === "年初"
            ? [year, 0, "first"]
            : base === "年末"
              ? [year, 11, "last"]
              : base === "年度初"
                ? [fiscalYear, 3, "first"]
                : [fiscalYear + 1, 2, "last"];
  const shifted = baseMonth + offsets.months;
  const y = baseYear + Math.floor(shifted / 12);
  const m = ((shifted % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  // 今日±か月で月末を越えるとき（3 月 31 日の 1 か月前など）は、その月の末日にする
  const d =
    day === "first" ? 1 : day === "last" ? lastDay : Math.min(day, lastDay);
  const date = new Date(Date.UTC(y, m, d + offsets.days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * 日付の値（'YYYY-MM-DD'・'YYYY/M/D'・'YYYYMMDD'）か相対の日付を、'YYYY-MM-DD' にする。
 * どちらでもない・実在しない日付は null
 */
export function resolveDateValue(text: string, now: Date): string | null {
  const trimmed = text.trim();
  if (/^\d{8}$/.test(trimmed)) return ymdToDateKey(trimmed);
  return normalizeDateKey(trimmed) ?? resolveRelativeDate(trimmed, now);
}
