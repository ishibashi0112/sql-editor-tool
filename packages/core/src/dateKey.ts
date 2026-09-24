// 日付キー（'YYYY-MM-DD'）の扱い。グリッドの日付フィルタはこの形で値を持つ

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * 'YYYY-MM-DD'（'YYYY/M/D' も可）を検証して 'YYYY-MM-DD' にそろえる。
 * 実在しない日付（2 月 30 日など）は null。DB に渡して変換エラーにしないため
 */
export function normalizeDateKey(text: string): string | null {
  const m = text.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return formatUtc(date);
}

/** 正規化済みの日付キーの翌日 */
export function nextDateKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return formatUtc(
    new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1)),
  );
}

/** 'YYYY-MM-DD' → 'YYYYMMDD' */
export function toYmd(key: string): string {
  return key.replaceAll("-", "");
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'。実在しない日付（'00000000' など）や形式違いは null */
export function ymdToDateKey(ymd: string): string | null {
  const m = ymd.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? normalizeDateKey(`${m[1]}-${m[2]}-${m[3]}`) : null;
}

/** ローカル時刻での日付キー（グリッドの formatDateKey と同じ規則） */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * グリッドの組み込みプリセットを、now 基準の両端を含む範囲にする（グリッドの resolveDateFilterPreset と同じ規則）。
 * 組み込みでない ID は null
 */
export function resolveBuiltinDatePreset(
  preset: string,
  now: Date,
): { from: string; to: string } | null {
  const today = localDateKey(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "thisMonth":
      return {
        from: localDateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: localDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
      };
    case "last30days":
      return {
        from: localDateKey(
          new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29),
        ),
        to: today,
      };
    default:
      return null;
  }
}
