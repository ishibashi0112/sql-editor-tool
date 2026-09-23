# spreadsheet-grid への機能追加の依頼

作成：2026-09-23。対象：`@ishibashi0112/spreadsheet-grid` v0.40.0（datasheet-grid リポジトリ）

この文書は、datasheet-grid リポジトリで作業するときに渡すためのものです。決定の経緯は `docs/handover.md` の D-12 と §11 にあります。API の名前や形はあくまで提案です。ライブラリの既存の設計や命名に合わせて変えてください。

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
