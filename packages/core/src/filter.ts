// フィルタ記述子。spreadsheet-grid（v0.40.0。v0.41.0 でも同形）の ColumnFilterValue / GridSortEntry と同じ形にしてあり、
// グリッドが通知する値をそのまま渡せる。core はグリッドに依存しないので、型はここで定義する。
// 各種類の意味は docs/handover.md §11.1

export type SetSelection = {
  /** 'exclude' のとき values は「選ばなかった値」。省略時は 'include' */
  mode?: "include" | "exclude";
  /** 値は文字列。'' は空欄（NULL と空文字）を表す。日付は 'YYYY-MM-DD' */
  values: readonly string[];
};

export type ParsedNumberFilter =
  | {
      mode: "comparison";
      operator: ">" | ">=" | "<" | "<=" | "=" | "!=";
      value: number;
    }
  | { mode: "range"; min: number; max: number }
  | { mode: "blank" }
  | { mode: "notBlank" };

export type ParsedTextFilter =
  | {
      mode: "contains" | "equals" | "startsWith" | "endsWith";
      value: string;
    }
  | { mode: "blank" }
  | { mode: "notBlank" };

export type ParsedDateFilter =
  | { mode: "range"; from: string; to: string }
  | {
      mode: "onOrAfter" | "onOrBefore" | "equals" | "notEquals";
      value: string;
    }
  | { mode: "blank" }
  | { mode: "notBlank" }
  /** 相対のまま保存されたプリセット。SQL を作るたびに解決する */
  | { mode: "preset"; preset: string };

export type ColumnFilterValue =
  | ({ kind: "set" } & SetSelection)
  | { kind: "number"; raw: string; parsed: ParsedNumberFilter | null }
  | {
      kind: "numberSet";
      condition: ParsedNumberFilter | null;
      set: SetSelection | null;
    }
  | { kind: "text"; value: string }
  | {
      kind: "textSet";
      condition: ParsedTextFilter | null;
      set: SetSelection | null;
    }
  | { kind: "date"; value: string }
  | {
      kind: "dateSet";
      condition: ParsedDateFilter | null;
      set: SetSelection | null;
    }
  | { kind: "select"; value: string }
  | { kind: "custom"; value: unknown };

export type SortEntry = {
  columnKey: string;
  direction: "asc" | "desc";
};
