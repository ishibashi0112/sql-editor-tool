// DB で絞り込んで取得した行と、画面の絞り込みの関係（D-25）

import type { ColumnFilterValue } from "@sql-editor-tool/core";

export type Filters = Record<string, ColumnFilterValue>;

/**
 * DB で絞り込んだ条件のうち、画面の絞り込みで外したり変えたりした列。
 * 同じ条件のまま、ほかの列の絞り込みを足すだけなら、表示中の行で足りるので空になる
 */
export function widenedColumns(fetched: Filters, current: Filters): string[] {
  return Object.keys(fetched).filter(
    (key) => JSON.stringify(fetched[key]) !== JSON.stringify(current[key]),
  );
}
