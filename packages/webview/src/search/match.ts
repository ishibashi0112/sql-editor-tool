// テーブル検索の判定。名前と論理名（D-40）の部分一致で、全角半角・大文字小文字を区別しない

import type { SchemaObject } from "@sql-editor-tool/host";

type Range = readonly [number, number];

export type SearchHit = {
  object: SchemaObject;
  /** 名前の中で、最初の語に一致した範囲（強調表示用）。出せないときは null */
  highlight: Range | null;
  /** 論理名の中で、最初の語に一致した範囲 */
  logicalHighlight: Range | null;
};

/** 全角英数と半角カナをそろえ、大文字小文字を区別しない */
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

/**
 * 空白で区切った語をすべて含むもの（「スキーマ.名前」か論理名のどこかに含む）。
 * 並びは、名前が最初の語で始まるもの → 論理名が始まるもの → 名前に含むもの → 論理名に含むもの
 * → スキーマだけに含むもの、同じなら名前が短い順
 */
export function searchObjects(
  objects: readonly SchemaObject[],
  query: string,
  limit: number,
): { hits: SearchHit[]; total: number } {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const [first] = terms;
  if (first === undefined) return { hits: [], total: 0 };
  const found: {
    object: SchemaObject;
    name: string;
    logical: string;
    index: number;
    logicalIndex: number;
  }[] = [];
  for (const object of objects) {
    const name = normalize(object.name);
    const logical = normalize(object.logicalName ?? "");
    const full = `${normalize(object.schema)}.${name}`;
    if (terms.every((term) => full.includes(term) || logical.includes(term))) {
      found.push({
        object,
        name,
        logical,
        index: name.indexOf(first),
        logicalIndex: logical ? logical.indexOf(first) : -1,
      });
    }
  }
  const rank = (hit: (typeof found)[number]) =>
    hit.index === 0
      ? 0
      : hit.logicalIndex === 0
        ? 1
        : hit.index > 0
          ? 2
          : hit.logicalIndex > 0
            ? 3
            : 4;
  found.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name, "ja") ||
      a.object.schema.localeCompare(b.object.schema, "ja"),
  );
  const hits = found.slice(0, limit).map((hit) => ({
    object: hit.object,
    // 正規化で文字数が変わる名前（半角カナの濁点など）は、位置がずれるので強調しない
    highlight: range(hit.index, first, hit.name, hit.object.name),
    logicalHighlight: range(
      hit.logicalIndex,
      first,
      hit.logical,
      hit.object.logicalName ?? "",
    ),
  }));
  return { hits, total: found.length };
}

function range(
  index: number,
  term: string,
  normalized: string,
  original: string,
): Range | null {
  return index >= 0 && normalized.length === original.length
    ? [index, index + term.length]
    : null;
}
