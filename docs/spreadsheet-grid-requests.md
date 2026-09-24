# spreadsheet-grid への機能追加の依頼

作成：2026-09-23。対象：`@ishibashi0112/spreadsheet-grid` v0.40.0（datasheet-grid リポジトリ）

この文書は、datasheet-grid リポジトリで作業するときに渡すためのものです。決定の経緯は `docs/handover.md` の D-12 と §11 にあります。API の名前や形はあくまで提案です。ライブラリの既存の設計や命名に合わせて変えてください。

## 対応状況（2026-09-24 追記）

**全項目が `@ishibashi0112/spreadsheet-grid@0.41.0`（core も 0.41.0）で対応済み。npm に公開済み。** 以下の依頼本文は当時の提案のまま残す。実装された API 名は提案と一部違うので、アプリ側はこの表で読み替える。公開 API は追加のみで、既存 API と既定の挙動は変わっていない（既定値のままなら v0.40.0 と同じ経路を通る）。

| 依頼 | 実装（v0.41.0） | 補足 |
|---|---|---|
| 1. IME | 修正済み（prop なし） | text / date / custom 入力と条件入力は変換中の Enter / Escape を無視する。numberSet / textSet の条件値は変換中は表示だけ更新し、`compositionend` で 1 回だけ記述子を送る。 |
| 2. 手動フィルタモード（提案名 `columnFilterMode`） | `manualFiltering?: boolean`（既定 `false`） | 列フィルタもグローバルフィルタも評価しない（number 列の Float64 前計算も走らない）。UI と `GridState.filters` の通知は従来どおり。`rows` が 0 件でフィルタが載っていれば `noMatchingRowsText` が出る。serverSide では無視。 |
| 3. 候補の非同期取得 | `getFilterOptions?: (params) => Promise<{ options; truncated? }>`（グリッド prop） | 引数は `{ columnKey, column, columnFilters（自列を除く他列の有効フィルタ）, globalText, signal }`。popover を開くたびに呼ばれ、閉じる / 列切替で `signal` が abort される。ライブラリはキャッシュしない（必要ならアプリ側で `columnKey` ＋他列フィルタをキーに Promise を保持する）。読み込み中 / 失敗（再試行ボタン）/ 打ち切り（「先頭のみ・打ち切り」の注記）の表示はライブラリ側。反転（exclude）可。優先順位は `column.filterOptions`（静的）＞ `getFilterOptions` ＞ rows 自動収集。対象は select / set / numberSet / textSet / dateSet。複合列は取得中も条件欄が使える。検索欄は取得済み候補の中だけを探す（検索文字列をサーバへ渡す再取得は無い）。 |
| 4. 手動ソートモード（提案名 `sortMode`） | `manualSorting?: boolean`（既定 `false`） | 並べ替えない。UI と `GridState.sort` の通知は従来どおり。再マウント不要で切り替え可（`false` へ戻すと即座にクライアントソートがかかる）。手動ソート中は行ドラッグ / `labelRow.sortMode` は「並べ替えていない」扱い。`enableSorting={false}` で既存ソートが外れない件は既存仕様のまま（`applyState` で `sort: []`）。 |
| 5. 変更通知 | `onFiltersChange?: (filters: GridFilterState) => void` / `onSortChange?: (sort: GridSortState) => void` | 該当スライスが構造的に変化したときだけ複製を渡して呼ばれる。初回マウント非発火 / 同値非発火 / `applyState` でも発火（`onStateChange` と同じ規約）。ドラッグ中の保留は無い。 |

アプリ側での使い方（想定）:

```tsx
<SpreadsheetGrid
  rows={rowsFromDb}
  columns={columns}          // filterFn: () => true の回避策は不要
  manualFiltering
  manualSorting={reachedLimit}   // 上限で打ち切ったときだけ ORDER BY をサーバへ
  onFiltersChange={(filters) => setWhere(buildWhere(filters.columnFilters))}
  onSortChange={(sort) => setOrderBy(buildOrderBy(sort))}
  getFilterOptions={({ columnKey, columnFilters, signal }) => fetchDistinct(columnKey, columnFilters, signal)}
/>
```

`getFilterOptions` の `value` は記述子の `values` にそのまま載る文字列。NULL は `''`（ラベルは `'(空白)'` など）、dateSet 列は `'YYYY-MM-DD'` を渡す。

参考: datasheet-grid の PR #4（項目 1・2・4・5）/ PR #5（項目 3）/ PR #6（0.41.0）。ガイドは website の「ソートとフィルター」の「絞り込み / 並べ替えを外部に委ねる」「候補を非同期に供給する」節。

## 背景

VS Code 拡張の DB 検索ツールで、spreadsheet-grid を使います。構成は「条件はサーバー（SQL の WHERE 句）、行はクライアント（上限つきで全件取得）」です（SSRM は使いません）。

1. ユーザーが列ヘッダのフィルタを操作します。
2. アプリはフィルタの記述子（`ColumnFilterValue`）を受け取り、WHERE 句を作ります。
3. Enter キーか実行ボタンで SQL を実行し、返ってきた行をクライアント行モデルでグリッドに渡します。

このときグリッドには、フィルタの UI を普通に動かしながら、グリッド自身では行を絞り込まないでほしいのです。行はすでに DB 側で絞り込まれているからです。今のバージョンにはこのモードがありません。

## 依頼内容（優先度順）

### 1. フィルタ入力の日本語入力（IME）の不具合の修正

この項目は、今回の用途に関係なく不具合です。

- 次の入力欄では、Enter キーの `nativeEvent.isComposing` を確認していません。そのため、変換を確定する Enter でフィルタまで確定してしまいます。
  - text / date / custom の入力欄（`packages/react/src/view/ColumnFilterPopover.tsx` の 1372〜1384 行付近）
  - 条件入力欄の `handleConditionKeyDown`（1203〜1216 行付近。number / textSet / dateSet で使う）
- textSet の条件入力は、変換中の文字でも 1 打鍵ごとにフィルタを dispatch します（540〜546 行付近 → `filterPopoverCommands.ts` の 393〜401 行付近）。変換中は dispatch しないようにしてください。変換が確定した時点（`compositionend`）で dispatch すれば十分です。
- 参考：Hayami の `ImeSafeText`（非制御入力のパターン）。

受け入れ条件：
- 日本語の変換を確定する Enter でポップオーバーが閉じない。
- 変換中の文字で `onStateChange` が発火しない。

### 2. 手動フィルタモード

- 例：`columnFilterMode?: 'client' | 'manual'`（既定は `'client'`）
- `'manual'` のときの動き：
  - フィルタの UI（ポップオーバー、フィルタ中の印、要約）は今までどおり動く。
  - 状態（`GridState.filters`）も今までどおり更新され、通知される。
  - 行の絞り込みだけを行わない。
- 変える場所の候補：`SpreadsheetGrid.tsx` の 981〜991 行付近の `rowPipeline.resolveOrder` には、空の列フィルタを渡す。グローバルフィルタ（969〜979 行付近）も適用しない。
- 手動モードで 0 件のときは、`noRowsText` ではなく `noMatchingRowsText` を出すのが自然です（今は `rows.length === 0` で判定しているため）。
- 今の回避策は、全列に `filterFn: () => true` を付けて `enableGlobalFilter={false}` にすることです。この回避策には次の問題があります。
  - 数値の列で Float64 のキーを作るという、不要な処理が走る。
  - 列定義が汚れる。

受け入れ条件：
- 手動モードで列フィルタを設定しても、表示される行と並びが変わらない。
- `onStateChange` には今までどおり `filters` が届く。

### 3. 集合フィルタの候補値を非同期に取得する API

- 今の問題：
  - 候補値は読み込んだ行から作られます。そのため、DB 側でその列の条件で絞り込んだ後に開くと、選んだ値しか出てきません。
  - `filterOptions`（同期）で渡すことはできますが、読み込み中の表示がありません。
  - `filterOptions` を使うと、反転（`exclude`）も使えなくなります。
- 例：
  ```ts
  getFilterOptions?: (params: {
    columnKey: string;
    /** いま開いている列を除く、ほかの列の有効なフィルタ（Excel と同じく、候補はほかの列の条件で絞る） */
    columnFilters: Record<string, ColumnFilterValue>;
    signal: AbortSignal;
  }) => Promise<{
    options: GridSelectFilterOption[];
    /** 件数上限で打ち切ったか。true なら「先頭 N 件のみ」などを表示する */
    truncated?: boolean;
  }>;
  ```
- 次のように動くことを想定しています。
  - ポップオーバーを開いたときに呼ぶ。読み込み中の表示を出し、閉じたら `signal` で中断する。
  - 失敗したらポップオーバー内にエラーを表示する。
  - 反転（`exclude`）は使えるままにする。「これ以外」は SQL では `NOT IN` にするので、打ち切られた候補の外にある値も正しく扱えます。
  - 複合フィルタ（textSet など）が、条件で候補を絞る今の動き（`numberFilterCondition.ts` の 172〜182 行付近と、その text / date 版）は、取得した候補に対してそのまま使う。
- SSRM でも同じ API が使えるはずです。API リファレンスでは「将来の拡張」になっています（`API_REFERENCE.md` の 1152 行付近）。

受け入れ条件：
- 候補がコールバックから取得され、読み込み中、エラー、中断の表示がある。
- 反転が使える。
- `truncated` のときに表示がある。

### 4. 手動ソートモード

- 例：`sortMode?: 'client' | 'manual'`（既定は `'client'`）
- `'manual'` のときの動き：
  - ソートの UI と状態の通知は今までどおり動く。
  - 行は渡された順のまま並べ替えない。
- アプリでは次のように切り替えます。再マウントせずに切り替えられることが必要です。
  - 取得が上限に達したときは `'manual'`。`ORDER BY` を付けて再クエリします。
  - 全件そろっているときは `'client'`。
- 補足：今は `enableSorting={false}` にしても、かかっているソートは外れません（`applyState` で `sort: []` にする必要がある）。

受け入れ条件：
- 手動モードでソートを操作しても行の並びが変わらない。
- `onStateChange` には今までどおり `sort` が届く。

### 5. フィルタとソートの変更だけを通知するコールバック（あれば便利）

- 例：`onFiltersChange?(filters: GridFilterState)`、`onSortChange?(sort: GridSortState)`
- `onStateChange` は列幅や列の表示・並びの変更でも呼ばれます。そのため今は、アプリ側で前回と比べて判定しています。なくても困りませんが、あると簡単になります。

## 依頼しないもの（参考）

- **`yyyymmdd` 文字列を日付として扱うこと**：アプリ側で `getValue` を使って `'YYYY-MM-DD'` に変換して渡すので、対応は不要です。
- **行を追加する（ストリーミング）API**：まずはアプリ側で、チャンクごとに配列を渡す方法を計測します。必要になったら改めて相談します。
