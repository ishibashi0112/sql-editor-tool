// 画面の上の文字の幅。等幅のエディタで縦に揃えるとき（論理名のコメントや札）に使う

/** 画面の上の幅（桁）。全角の文字は 2 桁、タブは次のタブの位置まで */
export function displayWidth(text: string, tabSize = 4): number {
  let width = 0;
  for (const c of text) {
    if (c === "\t") {
      width += tabSize - (width % tabSize);
      continue;
    }
    const code = c.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}
