// 論理名（D-40）。DB のコメント（SQL Server は拡張プロパティ MS_Description、Oracle は COMMENT ON）を
// A5:SQL Mk-2 の既定と同じく、最初のタブ・改行・半角の「:」で「論理名」と「コメント」に分ける。
// 例：「受注日:受注を受けた日（yyyymmdd）」→ 論理名「受注日」、コメント「受注を受けた日（yyyymmdd）」

/** 論理名とコメント。ないものは持たない */
export type LogicalName = {
  logicalName?: string;
  comment?: string;
};

/** DB のコメント → 論理名とコメント。区切りがなければ、全体が論理名 */
export function splitDbComment(text: string | null | undefined): LogicalName {
  if (!text) return {};
  const cut = /[\t\r\n:]/.exec(text);
  const head = (cut ? text.slice(0, cut.index) : text).trim();
  const rest = cut ? text.slice(cut.index + 1).trim() : "";
  const result: LogicalName = {};
  if (head) result.logicalName = head;
  if (rest) result.comment = rest;
  return result;
}

/** 画面に出す長さの上限。長い論理名（説明文をそのまま入れたものなど）は省略し、全体はツールチップに出す */
const SHORT_LENGTH = 24;

/** 列見出しやインレイヒントに出す短い論理名 */
export function shortLogicalName(name: string): string {
  const chars = [...name];
  return chars.length > SHORT_LENGTH
    ? `${chars.slice(0, SHORT_LENGTH - 1).join("")}…`
    : name;
}
