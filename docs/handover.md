# 引き継ぎ資料：A5:SQL Mk-2 代替 GUI 検索ツール（仮称未定）

最終更新：2026-09-23（Claude Code へ移行後、O-04 の確認、O-06〜O-08 の決定、core の WHERE 生成の実装を反映）

このドキュメントは、チャットで検討した内容を Claude Code で途中から再開するためのものです。
「確定」はユーザーが合意したもの、「提案」は Claude が提案してユーザーが概ね合意した段階のもの、「未確定」は要確認・要決定のものです。

---

## 1. 背景と目的

- 普段、社内 DB（SQL Server / Oracle）のデータ取得に A5:SQL Mk-2 を使っている。
- WHERE 句を手で書く部分を GUI 化し、「列ヘッダのフィルタ操作 → WHERE 句の生成 → DB で実行」という形でデータを絞り込めるツールを作る。
- 表示には自作の `@ishibashi0112/spreadsheet-grid` を使う。
- 将来的に、同じ土台の上に次の 2 機能を載せる（キープ中の案）。
  - **DB 差分カメラ**：画面操作の前後でテーブルのスナップショットを取り、変わった行・列を差分表示する。動作検証とレガシー画面の仕様調査に使う。
  - **検証エビデンス自動作成**：ホットキーでスクショ＋メモを記録し、手順番号付きの検証記録（Excel）を出力する。差分カメラの結果も貼れるようにする。

## 2. 環境の前提

| 項目 | 内容 | 状態 |
|---|---|---|
| SQL Server | おそらく 2012 | 未確定（O-03） |
| Oracle | 19c と記載されていた記憶 | 未確定（O-02） |
| 外部キー | 社内 DB に外部キー制約を使っているテーブルはない認識 | 確定 |
| 主キー | 複合主キーのテーブルが多い | 確定 |
| 日付の持ち方（SQL Server） | `yyyymmdd` 形式の文字列（Hayami の知見） | 確定 |
| 日付の持ち方（Oracle） | DATE 型だった気がするが自信なし | 未確定（O-01） |
| vsix | 会社 PC の VS Code に自作拡張をインストールできることを確認済み | 確定 |
| ネットワーク | DB は社内ネットワークからのみ到達可能。Mac からは接続できない | 確定 |

開発は Mac（Claude Code）で行い、DB に繋ぐ検証は会社 PC で行う。検証結果は、ホスト名・IP・DB 名・業務データをマスクしてから持ち帰る。

## 3. 決定事項

| No | 内容 | 状態 |
|---|---|---|
| D-01 | ホストは VS Code 拡張で進める | 確定 |
| D-02 | 結合は ANSI 形式（`JOIN ... ON`）のみ扱う。Oracle 独自の `(+)` 記法は扱わない | 確定 |
| D-03 | 段階1は SSRM を使わない。「条件はサーバー（WHERE 句）、行はクライアント（上限つき全件取得）」の構成にする | 確定（Claude 推奨にユーザーが同意） |
| D-04 | 段階的に進める：段階1＝単一テーブル／ビュー、段階2＝ベースSQL＋GUIフィルタ、段階3＝関連テーブル条件（EXISTS） | 提案（概ね合意） |
| D-05 | 読み取り専用。生成・実行するのは SELECT（と WITH）のみ | 提案（概ね合意） |
| D-06 | DB 上の型と「意味上の型」を分けて持つ（例：VARCHAR(8) だが意味は日付） | 提案 |
| D-07 | ドライバは SQL Server が `mssql`（tedious）、Oracle が `node-oracledb` の Thin モード | 提案 |
| D-08 | モノレポ構成で、core（方言・WHERE 生成・スキーマモデル）をホスト非依存にする | 提案（概ね合意） |
| D-09 | Hayami の D-14 セキュリティ原則を引き継ぐ（§8） | 提案 |
| D-10 | コーディング規約は Hayami 寄り：pnpm モノレポ、Biome（2 スペース、ダブルクォート、recommended）、TS strict＋`noUncheckedIndexedAccess`＋`exactOptionalPropertyTypes`＋`verbatimModuleSyntax`、`.gitattributes` で LF 固定、日本語コメント。テストは vitest（拡張は Bun ではなく VS Code 内蔵の Node で動くため） | 確定（O-06） |
| D-11 | 取得上限の既定値は 10 万行（設定で変更可） | 確定（O-07） |
| D-12 | spreadsheet-grid に足りない機能（§11.3）はライブラリ側に追加する。依頼内容は `docs/spreadsheet-grid-requests.md`。ライブラリが対応するまで、アプリは回避策（`filterFn: () => true`）で進める | 確定（O-08） |
| D-13 | 名前が決まるまで、パッケージは仮称 `@sql-editor-tool/*` で作り、決まったら置き換える | 確定 |

## 4. 未確定事項

| No | 内容 | 確認方法 | 状態 |
|---|---|---|---|
| O-01 | Oracle 側の日付は DATE 型か、`yyyymmdd` 文字列か。DATE 型なら時刻部分を使っているか | `verify/` の SQL で確認 | 未確定 |
| O-02 | Oracle に node-oracledb の Thin モードで接続できるか（バージョン、パスワード方式、ネイティブネットワーク暗号化の要否） | `verify/oracle-run.mjs` | 未確定 |
| O-03 | SQL Server のバージョンの確定と、VS Code 内蔵 Node.js（Bun ではない）で `encrypt: false` の接続ができるか | `verify/mssql-run.mjs` | 未確定 |
| O-04 | spreadsheet-grid に「クライアント行モデルのまま、フィルタ操作を記述子として外に通知するだけで、グリッド自身では絞り込まない」モード（外部フィルタモード）があるか。なければライブラリ側に追加 | spreadsheet-grid のコードを確認 | 確認済み：**ない**（§11）。対応は O-08 |
| O-05 | プロダクト名（リポジトリ名）。将来 A5 のような汎用 SQL エディタに育つ可能性もあるので、「フィルタ」に限定しない名前がよい。好み：短いローマ字の日本語で、掛け言葉になっている日常語 | ユーザーが決定 | 未確定。キープ：kumu（汲む／組む）、hikidashi（引き出し）。見送り：shiboru、saguru、shirabe、sukuu、tansu、hishaku、tsurube、ami、taguru、ukagau、yomu、furui、hikiami、mekuru、toru |
| O-06 | コーディング規約（Biome、TS strict、改行コード、日本語コメントなど）。既存の spreadsheet-grid / Hayami に合わせるか | ユーザーが決定 | 解決（D-10） |
| O-07 | 取得上限の既定値。提案は 10 万行（設定で変更可） | ユーザーが決定 | 解決（D-11） |
| O-08 | spreadsheet-grid に足りない機能（§11.3）を、ライブラリ側に追加するか、アプリ側の回避策で済ませるか | ユーザーが決定 | 解決（D-12） |
| O-09 | 文字列比較の細部。(1) 大文字小文字：グリッドのクライアント側判定は区別しない。SQL Server は照合順序次第（多くは区別しない）、Oracle は既定で区別する。Oracle で区別しないようにすると `UPPER(col)` でインデックスが効かなくなる。(2) 空白だけの値：グリッドは空欄として扱う。SQL Server の `col = ''` は末尾空白を無視するので一致するが、Oracle の `col IS NULL` は一致しない（CHAR 列に空白を入れて「空」としている運用がないか）。(3) Oracle の CHAR 列の `RPAD(:p, 列長)`：RPAD の長さは表示幅なので、全角文字を含む値や BYTE 単位の列長で合わない可能性がある。node-oracledb で `DB_TYPE_CHAR` としてバインドする案もある | 会社 PC で確認（O-03 の照合順序、`verify/` の型の分布、CHAR 列での実際の比較）。(1) はその結果を見てユーザーが決定 | 未確定 |

## 5. 段階計画

### 段階1：単一テーブル／ビュー＋GUI フィルタ

- **接続管理**：接続プロファイルを作成。パスワードは VS Code の SecretStorage に保存し、表示もログ出力もしない。
- **スキーマツリー**：サイドバーに VS Code 標準の TreeView でスキーマ・テーブル・ビューを表示し、名前で検索できる。
- **データビュー**：Webview に React＋spreadsheet-grid を表示。列ヘッダのフィルタから WHERE 句を生成する。
- **SQL プレビュー**：生成された SQL を常に表示。コピーは「バインド変数のまま」と「リテラルに展開した A5 に貼れる版」の 2 種類。
- **実行タイミング**：フィルタ変更中は SQL プレビューだけを更新し、Enter キーか実行ボタンで初めて DB に投げる。
- **取得**：
  - 上限件数＋1 件を取得し、はみ出したら「上限に達しました。条件を追加してください」と表示する。
  - 件数の制限は、SQL Server が `TOP (n)`、Oracle が `FETCH FIRST n ROWS ONLY`。
  - 既定の ORDER BY は主キー列（安定した並びにするため）。
  - ドライバのストリーミング取得を使い、列ごとの配列をチャンクで Webview に送る。最初のチャンクが届いた時点で表示を始める。
  - 取得中は件数と進捗を表示し、キャンセルできる（`mssql` は request のキャンセル、oracledb は `connection.break()` を想定）。
- **ソート**：全件の取得が終わるまで無効。上限に達した場合は、クライアント側ソートではなく ORDER BY 付きで再クエリする。
- **列の意味型の上書き**：テーブル・列ごとに意味型（日付など）を指定して保存する。長さ 8 の文字列列で、名前が「〜日」「〜YMD」「〜DATE」などのものは候補として提案し、確定はユーザーが行う。
- **キーの上書き**：主キーのないテーブルやビューでは、ユーザーがキー列を指定して保存できる。

### 段階2：ベースSQL＋GUI フィルタ

- JOIN を含む SELECT 文はユーザーがテキストで書く。ツールがそれを `SELECT * FROM ( <ベースSQL> ) t WHERE <GUI条件>` の形で包む。
- Oracle ではサブクエリの別名に `AS` を付けられないので、方言レイヤーで吸収する。
- ベースSQL 内で列名が重複すると外側の SELECT でエラーになるので、事前に検出して別名を促す。
- 列のメタデータは、SQL Server が `sp_describe_first_result_set`（Hayami で実績あり）、Oracle が 0 件取得での記述情報から得る想定。
- よく使うベースSQL は名前付きで保存し、「自分専用のビュー」として使い回せるようにする。

### 段階3：関連テーブルの条件で絞る（必要になったら）

- 「JOIN 先の条件で絞りたいだけ」の場面を `EXISTS` で生成する。行が重複せず、結果は元テーブルのまま。
- 外部キーがないので、テーブル間の関係（複合キーのペアを含む）を一度だけ手で登録して保存する仕組みを作る。

### その後

- DB 差分カメラ：複合主キーのタプルで行の同一性を判定する。取得の仕組みは段階1のものを流用する。
- 検証エビデンス自動作成：差分カメラの結果も出力に含める。
- テーブル定義書（Excel）から日本語の論理名を読み込み、列見出しに表示する。

## 6. WHERE 生成の仕様と注意点

### フィルタと SQL の対応

| フィルタ | 生成する SQL | 注意 |
|---|---|---|
| 文字列：等しい | `col = :p` | Oracle の CHAR 列は下記参照 |
| 文字列：含む／前方一致／後方一致 | `col LIKE :p ESCAPE '\'` | 入力値の `%` `_` `\` をエスケープする。SQL Server は `[` も文字クラスの開始になるのでエスケープする。CHAR 列の後方一致は `RTRIM(col) LIKE`（後方一致はもともとインデックスが効かない） |
| 空欄 | SQL Server：`(col IS NULL OR col = '')`、Oracle：`col IS NULL` | Oracle では空文字が NULL として扱われる |
| 数値：比較・範囲 | `col >= :a AND col <= :b` など | |
| 日付（意味型＝日付、DB 型＝`yyyymmdd` 文字列） | `col >= '20260901' AND col <= '20260930'` | 文字列の大小と日付の前後が一致するので、この形で正しい。SQL Server では `<=` と `<>` に空文字が引っかかるので `AND col <> ''` を付ける |
| 日付（日付型。時刻を持ちうる列） | Oracle：`col >= TO_DATE(:p1, 'YYYYMMDD') AND col < TO_DATE(:p2, 'YYYYMMDD')`、SQL Server：`CONVERT(date, @p1, 112)` | 時刻を含むので、等号ではなく [当日, 翌日) の範囲にする。翌日は JavaScript 側で計算する。値は `yyyymmdd` の文字列で渡して SQL 側で変換する（Date で渡すと、ドライバのタイムゾーン変換で日がずれることがある。`mssql` は既定で UTC 扱い）。SQL Server の `date` 型など時刻を持たない列は `=` で比べる。Oracle の DATE で時刻を使っていなければ同様にできる（O-01） |
| セット：選択した値 | `col IN (...)`（1 個なら `col = :p`） | Oracle は IN の要素が 1000 個までなので、分割して OR で繋ぐ。SQL Server はパラメータが 1 文あたり 2100 個までで、分割しても回避できない。2000 個を超えたらエラーにして、反転や条件の追加を促す。時刻を持ちうる日付列は、日ごとの範囲を OR で繋ぐ |
| セット：反転（これ以外） | `col NOT IN (...)` ＋ NULL の扱いを明示 | NOT IN は NULL の行を落とす。グリッドの反転は「空欄も除く」指定がなければ空欄の行を残すので、`(col NOT IN (...) OR col IS NULL)` にする。空欄も除くなら `col IS NOT NULL AND col NOT IN (...)` |
| セット：何も選ばない | `1 = 0` | グリッドと同じく 1 行も出さない |

### 方言・型の注意点

- **値は必ずバインド変数**：文字列連結はしない。
- **Oracle の CHAR 列**：文字列をバインドして CHAR 列と比較すると、末尾空白の扱いの違いで一致しないことがある。インデックスを効かせるため、列側ではなくバインド側を `RPAD(:p, 列長)` で埋める。SQL Server の `=` は末尾空白を無視するので不要。
- **SQL Server のバインド型**：`mssql` は文字列パラメータを既定で NVARCHAR として送る。VARCHAR 列と比較すると暗黙の型変換でインデックスが効かなくなることがあるので、スキーマ情報から列の実際の型（VARCHAR と長さ）でバインドする。
- **数値の精度**：Oracle の NUMBER や SQL Server の decimal で 15 桁を超えうる列は、JavaScript の数値に変換すると下の桁が狂う。文字列として取得する（方法はドライバごとに実装時に検証）。
- **セットフィルタの候補値**：DB から `DISTINCT` に件数上限をかけて取得する。
- **識別子**：列名・テーブル名は常に引用符で囲む（SQL Server は `[...]`、Oracle は `"..."`）。予約語や日本語の列名でも壊れないようにするため。
- **実装**：`packages/core/src/where.ts`（条件）、`select.ts`（SELECT 文）、`dialect.ts`（方言の差）。SQL は `sql` タグ付きテンプレートで組み立て、値は `Param` としてしか埋め込めないようにしている。バインド版と A5 に貼るリテラル版は、同じ断片から出力する。

## 7. アーキテクチャ（提案）

pnpm のモノレポ。

```
packages/
  core/            方言、フィルタ記述子 → WHERE 句、スキーマモデル。依存なしの純 TypeScript。一番厚くテストする
  driver-mssql/    mssql（tedious）のアダプタ
  driver-oracle/   node-oracledb（Thin）のアダプタ
  extension/       VS Code 拡張本体（ホスト側）
  webview/         React＋spreadsheet-grid の画面
```

- core はホストに依存させない。将来デスクトップ版（Hayami 系の Electrobun や webview2-bridge）に載せ替えられるようにするため。
- core のフィルタ記述子は、spreadsheet-grid のフィルタ記述子（判別共用体）と対応させる。
- Mac では DB に繋げないので、core は DB なしで単体テストできるようにする。
- Webview の注意点：VS Code が一部のショートカット（Ctrl+P、Ctrl+W など）を先に取るので、Excel 風のキー操作と衝突しうる。
- 日本語入力：フィルタの入力欄には、Hayami の `ImeSafeText`（D-19）と同じ非制御入力のパターンを使う。

## 8. セキュリティ原則（Hayami の D-14 を引き継ぎ）

- パラメータ化クエリのみ。
- パスワードは書き込み専用（保存はするが、表示・ログ出力はしない）。
- ログのマスキングは長さを考慮する（短い秘密情報を単純な部分一致で置換すると、無関係な語を壊すため）。
- 読み取り専用を既定にする。
- 社内のホスト名・IP・DB 名・業務 SQL・業務データを、リポジトリ、スクリーンショット、チャットに出さない。検証結果を共有するときはマスクする。

## 9. 関連プロジェクト

| プロジェクト | 関係 |
|---|---|
| `@ishibashi0112/spreadsheet-grid` | 表示に使う。フィルタ記述子の判別共用体、SSRM（段階1では使わない）、セットフィルタの反転表現、日本語入力と Excel 風のキー操作を重視 |
| Hayami（`ishibashi0112/hayami`） | SQL Server 2012 への tedious 接続（`encrypt: false`）、`sp_describe_first_result_set`、D-14 セキュリティ原則、`ImeSafeText` の知見を流用 |
| webview2-bridge | 将来デスクトップ版にする場合の候補ホスト |
| slnmix / legacy_vb_workbench | VS Code 拡張の開発・vsix 配布の実績 |

## 10. 次のステップ

1. ~~このキットでリポジトリを初期化する（`git init`、初回コミット）。~~ 済み（2026-09-23。`.gitignore` を追加）
2. 会社 PC で `verify/` を実行し、O-01〜O-03 を確認する。結果はマスクして持ち帰り、このドキュメントを更新する。
3. ~~O-04（spreadsheet-grid の外部フィルタモード）を確認する。~~ 済み（§11）。対応方針は O-08
4. ~~モノレポの雛形を作る。~~ 済み（仮称 `@sql-editor-tool/*`、D-13）。O-05（名前）は未確定のまま
5. ~~core から実装する：フィルタ記述子 → WHERE 句（SQL Server / Oracle の両方言）を、単体テスト付きで作る。~~ 済み（`packages/core`、SELECT 文とリテラル版を含む）
   - 残り：セットフィルタの候補値の SQL（`SELECT DISTINCT` ＋件数上限。ほかの列の条件で絞る）、段階2のベースSQL の包み込み
   - spreadsheet-grid への機能追加（D-12）は datasheet-grid リポジトリで進める
6. ドライバのアダプタ、拡張本体、Webview の順に進める。

## 11. spreadsheet-grid の調査結果（O-04、v0.40.0）

調べた対象はローカルの `datasheet-grid` リポジトリ（`packages/core` = `@ishibashi0112/spreadsheet-grid-core`、`packages/react` = `@ishibashi0112/spreadsheet-grid`）。公開型は `packages/core/src/model/gridTypes.core.ts` にある。

### 11.1 フィルタ記述子

- 列フィルタの値は判別共用体 `ColumnFilterValue`。種類（`kind`）は `set` / `text` / `textSet` / `number` / `numberSet` / `date` / `dateSet` / `select` / `custom`。
- 列ごとの種類は列定義の `filterType` で指定する（`'auto'` は初回に推定）。
- 各種類の意味（グリッドのクライアント側判定）：

| kind | 中身 | クライアント側の判定 |
|---|---|---|
| `text` / `date` | `value: string` | 前後空白を除いた部分一致、大文字小文字を区別しない（`date` も同じ） |
| `select` | `value: string` | 完全一致 |
| `number` | `raw`（表示用）＋ `parsed`（比較 `> >= < <= = !=`／範囲 `min,max`／`blank`／`notBlank`） | `parsed` が null のときは `raw` の部分一致 |
| `set` | `mode?: 'include' \| 'exclude'`、`values: string[]` | `exclude` は `values` が「選ばなかった値」。UI は少ない側を保存する |
| `textSet` | `condition`（`contains` / `equals` / `startsWith` / `endsWith` / `blank` / `notBlank`）AND `set` | 条件と選択の AND |
| `numberSet` | `condition`（number の `parsed` と同じ）AND `set` | 同上 |
| `dateSet` | `condition`（`range` / `onOrAfter` / `onOrBefore` / `equals` / `notEquals` / `blank` / `notBlank` / `preset`）AND `set` | 同上。`set` の値は `'YYYY-MM-DD'` に正規化される |
| `custom` | `value: unknown` | 列の `filterFn` に任せる |

- 1 列の中で OR はない。列どうしは AND。
- 集合フィルタの値は文字列（`String(値 ?? '')`）。空欄は `''` で表し、NULL・undefined・空文字をまとめて「（空白）」として扱う。
- `blank` は NULL・undefined・前後空白を除くと空になる文字列。
- 日付のプリセット（`today` / `thisMonth` / `last30days` とカスタム）は相対のまま保存され、評価のたびに解決される。
- ソート状態は `GridSortEntry[]`（`{ columnKey, direction: 'asc' | 'desc' }`）。

core のフィルタ記述子はこの形に合わせる。core はグリッドに依存させず、同じ形の型を core 側に定義する。

### 11.2 外部フィルタモードはない

- 手動フィルタや手動ソートのモードはない。フィルタやソートを外から制御する props もない。
- 外から状態を得る方法は `onStateChange(state: GridState)` だけ。`GridState` には `filters` と `sort` が入る。デバウンスはなく、列幅などの変更でも呼ばれる。
- 外から状態を書く方法は `handle.applyState(state)`。
- クライアント側の絞り込みは `SpreadsheetGrid.tsx` の `rowPipeline.resolveOrder` で常に適用される。`enableColumnFilter` や `enableSorting` で止まるのは UI だけ。
- 列の `filterFn` はすべての種類より優先される。

### 11.3 アプリ側から見て足りない点

1. **グリッド自身の絞り込みを止められない**。回避策は、フィルタ対象の全列に `filterFn: () => true` を付け、`enableGlobalFilter={false}` にすること。そのうえで `onStateChange` を自前でデバウンスし、WHERE を作る。
2. **集合フィルタの候補値**。候補は読み込んだ行から作られるため、その列の条件で DB 側を絞り込んだ後に開くと、選んだ値しか出てこない。外から渡せるのは列定義の `filterOptions`（同期、`{ label, value }[]`）だけで、次の制約がある。
   - 読み込み中の表示がない。
   - 反転（`exclude`）が使えなくなる。
   - 非同期に取得して渡す API はない（ライブラリの API リファレンスでは「将来の拡張」扱い）。
3. **ソート**。手動ソートのモードはなく、クライアント側のソートが常にかかる。比較は `Intl.Collator('ja', { numeric: true })` なので、数字を含む文字列の並びは DB の `ORDER BY` と一致しないことがある。`enableSorting={false}` にしても、かかっているソートは外れない（`applyState` で `sort: []` にする必要がある）。
4. **日本語入力**。フィルタの入力欄はすべて制御コンポーネントで、`compositionstart` / `compositionend` の扱いはない。
   - 次の入力欄では、Enter キーの `isComposing` を確認していない。変換を確定する Enter でフィルタが確定してしまう。
     - text / date / custom の入力欄（`ColumnFilterPopover.tsx` の 1372〜1384 行付近）
     - 条件入力欄（1203〜1216 行付近）
   - textSet の条件入力は、変換中の文字でも 1 打鍵ごとに状態を送る。
5. **`yyyymmdd` 文字列は日付として認識されない**。日付キーの判定には区切り文字が必要。`'auto'` だと数値の列と推定される。アプリ側で、意味型が日付の列だけ `getValue` を使って `'YYYY-MM-DD'` に変換して渡せば、`dateSet` が使える。この場合、記述子には `'YYYY-MM-DD'` で入ってくるので、core で DB の形式に戻す。
6. 行の追加（ストリーミング）用の API はない。追加するたびに新しい配列を渡すと、並び・フィルタ・ソートが再計算される。チャンクごとに渡すか、まとめて渡すかは Webview の実装時に計測して決める。

### 11.4 その他

- npm に公開済み（`@ishibashi0112/spreadsheet-grid@0.40.0`）。ESM と CJS の両方を配布している。
- peer 依存は React 19。
- CSS は `import '@ishibashi0112/spreadsheet-grid/style.css'` で明示的に読み込む。
- SSRM をアダプタとして使う案（`getRows` で SQL を実行し、N 行をキャッシュして切り出して返す）では、グリッドがローカルで絞り込みもソートもしなくなる。ただし次の理由で採らない。
  - フィルタ変更から 300ms 後に `getRows` が呼ばれるので、「Enter で初めて DB に投げる」仕様と合わない。
  - 全件取得後にクライアント側でソートする使い方ができない。
  - D-03 とも合わない。
