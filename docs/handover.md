# 引き継ぎ資料：A5:SQL Mk-2 代替 GUI 検索ツール（仮称未定）

最終更新：2026-09-24（D-15〜D-20 をユーザーが確定。D-18 は実行ボタンのみに変更し、Ctrl+Enter を外した）

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
| D-12 | spreadsheet-grid に足りない機能（§11.3）はライブラリ側に追加する。依頼内容は `docs/spreadsheet-grid-requests.md`。ライブラリが対応するまで、アプリは回避策（`filterFn: () => true`）で進める | 確定（O-08）。**対応済み**：v0.41.0 で全項目が入り npm に公開された（2026-09-24、§11.5） |
| D-13 | 名前が決まるまで、パッケージは仮称 `@sql-editor-tool/*` で作り、決まったら置き換える | 確定 |
| D-14 | Webview は `@ishibashi0112/spreadsheet-grid` **0.41.0 以上**を使い、回避策（全列の `filterFn: () => true`）は使わない。`manualFiltering` / `manualSorting` / `onFiltersChange` / `onSortChange` / `getFilterOptions` を使う（実装名は提案と違う。読み替えは §11.5 と `docs/spreadsheet-grid-requests.md` の対応表） | 確定 |
| D-15 | 段階1では、グリッドのグローバルフィルタ（上部バーの検索欄）を使わない（`enableGlobalFilter={false}`）。`manualFiltering` ではグリッドが絞り込まず、core も `globalText` を WHERE にしないので、入力しても何も起きないため。全列の LIKE を OR で繋ぐ案は、インデックスが効かず重いので見送る | 確定（当面） |
| D-16 | 集合フィルタの候補値は、DB から `SELECT DISTINCT` に件数上限をかけて取得する（§6）。上限の既定値は 1 万件（Excel の候補表示と同じ。設定で変更可）。グリッドの候補リストは仮想化されているので、1 万件でも表示できる | 確定（当面） |
| D-17 | ベースSQL は「1 つの SELECT / WITH 文で、バインド変数を含まないもの」に限る。SQL Server では、最上位の ORDER BY は TOP か OFFSET があるときだけ使える（派生テーブルの制約）。並べ替えは列見出しで指定する（§5 段階2） | 確定（当面） |
| D-18 | DB への実行は「実行」ボタンを押したときだけ。キー操作（§5 の Enter キー、Ctrl+Enter）では実行しない。Enter はグリッドのセル移動やフィルタの確定と重なるため | 確定 |
| D-19 | 行は「行ごとの配列」（`CellValue[][]`）のチャンクで Webview に送る。§5 の「列ごとの配列」から変える。グリッドの `getValue: row => row[i]` でそのまま読め、行オブジェクトへの変換が要らないため。Webview は受け取った行を 200ms ごとにまとめて画面に反映する | 確定（当面） |
| D-20 | VS Code に依存しないアプリ層を `packages/host` に置く（Webview とのメッセージ、ドライバのインターフェイス `DbSession`、データビューの制御 `DataViewController`、デモ接続）。拡張はこれを VS Code につなぐだけにする。ブラウザの開発用ページでも同じ制御を動かせる（§12） | 確定 |

## 4. 未確定事項

| No | 内容 | 確認方法 | 状態 |
|---|---|---|---|
| O-01 | Oracle 側の日付は DATE 型か、`yyyymmdd` 文字列か。DATE 型なら時刻部分を使っているか | `verify/` の SQL で確認 | 未確定 |
| O-02 | Oracle に node-oracledb の Thin モードで接続できるか（バージョン、パスワード方式、ネイティブネットワーク暗号化の要否） | `verify/oracle-run.mjs` | 未確定 |
| O-03 | SQL Server のバージョンの確定と、VS Code 内蔵 Node.js（Bun ではない）で `encrypt: false` の接続ができるか | `verify/mssql-run.mjs` | 未確定 |
| O-04 | spreadsheet-grid に「クライアント行モデルのまま、フィルタ操作を記述子として外に通知するだけで、グリッド自身では絞り込まない」モード（外部フィルタモード）があるか。なければライブラリ側に追加 | spreadsheet-grid のコードを確認 | 確認済み：v0.40.0 には**ない**（§11）→ v0.41.0 で `manualFiltering` として追加された（§11.5、D-14） |
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
- **実行タイミング**：フィルタ変更中は SQL プレビューだけを更新し、実行ボタンで初めて DB に投げる（D-18）。
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
- 実装（core、`baseSql.ts`）：`buildSelect` / `buildFilterOptionsQuery` の `source` に `{ kind: "baseSql", sql }` を渡す。`SELECT * FROM (\n<ベースSQL>\n) base_query` の形にする（別名には AS を付けない）。
  - SQL Server は派生テーブルの中に WITH を書けないので、CTE の並びを外側の SELECT の前に出す。外に出した部分は括弧で守られないので、「名前 [(列…)] AS (…) [, …] SELECT」の並びを厳密に確かめる（T-SQL はセミコロンなしで文を続けられるため）。Oracle は WITH ごと中に入れる。
  - 次の場合はエラーにする（D-17）：空、複数の文（末尾のセミコロンは取り除く）、SELECT / WITH 以外で始まる文、バインド変数（SQL Server の `@x`、Oracle の `:x`）、最上位の `INTO` と `FOR UPDATE`、SQL Server で TOP も OFFSET もない最上位の ORDER BY。
  - 判定には簡易な字句解析を使う。文字列、`N'...'`、Oracle の `q'[...]'`、引用符つきの名前（`"..."`、SQL Server の `[...]`）、コメント（SQL Server は入れ子に対応）の中の記号は、構文として扱わない。
  - 列名の重複と名前のない列は `checkBaseColumns` で検出する。メタデータを取得した後に呼ぶ。SQL Server では大文字小文字を区別せず、Oracle では区別して比べる。
  - 読み取り専用を守る仕組みは、派生テーブルで包むこと（中には問い合わせしか書けない）。字句の検査は、DB のエラーより分かりやすいメッセージを出すためのもの。さらに守るなら、ドライバの段階で Oracle は `SET TRANSACTION READ ONLY` を使い、両方の DB で参照権限だけのアカウントを使う（ドライバの実装時に検討する）。

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
- **セットフィルタの候補値**：DB から `DISTINCT` に件数上限をかけて取得する（D-16）。
  - ほかの列の条件で絞る。候補を取る列自身の条件は使わない（グリッドが取得した候補に当てる）。
  - 上限 + 1 件を取り、はみ出したら打ち切り（`truncated`）とする。
  - 空欄を先頭に並べる（Oracle は `NULLS FIRST`、SQL Server は昇順で NULL と空文字が先頭）。打ち切られても空欄は候補に残る。
  - 日付型の列は `CONVERT(char(8), col, 112)` / `TO_CHAR(col, 'YYYYMMDD')` で日単位の文字列にして取る。時刻を持つ列でも候補は日ごとになり、Date で受けたときのタイムゾーンのずれも起きない。
  - 結果は `toFilterOptions` で候補にする。NULL と空文字は `''`（ラベル `（空白）`）、日付は `'YYYY-MM-DD'`。その値をそのまま WHERE の生成に渡せる。
  - 列に索引がない大きいテーブルでは、`DISTINCT` が全件走査になる。所要時間は会社 PC で確かめる。
- **識別子**：列名・テーブル名は常に引用符で囲む（SQL Server は `[...]`、Oracle は `"..."`）。予約語や日本語の列名でも壊れないようにするため。
- **実装**：`packages/core/src/where.ts`（条件）、`select.ts`（SELECT 文）、`filterOptions.ts`（集合フィルタの候補値）、`baseSql.ts`（段階2のベースSQL）、`dialect.ts`（方言の差）。SQL は `sql` タグ付きテンプレートで組み立て、値は `Param` としてしか埋め込めないようにしている。バインド版と A5 に貼るリテラル版は、同じ断片から出力する。

## 7. アーキテクチャ（提案）

pnpm のモノレポ。

```
packages/
  core/            方言、フィルタ記述子 → WHERE 句、スキーマモデル。依存なしの純 TypeScript。一番厚くテストする
  host/            VS Code に依存しないアプリ層（D-20）：Webview とのメッセージ、DbSession、DataViewController、デモ接続
  driver-mssql/    mssql（tedious）のアダプタ（未作成。DbSession を実装する）
  driver-oracle/   node-oracledb（Thin）のアダプタ（未作成。DbSession を実装する）
  extension/       VS Code 拡張本体：接続の管理、ツリー、Webview パネル。host を VS Code につなぐ
  webview/         React＋spreadsheet-grid の画面。dev/ はブラウザで確かめる開発用ページ
```

- ドライバが守ること（`packages/host/src/session.ts`）：結果の列名を `onColumns` で先に渡す。行は数百〜数千行ずつ `onRows` で渡す。日付・時刻は `'YYYY-MM-DD HH:mm:ss'` などの文字列、15 桁を超えうる数値は文字列にする。`signal` が中断されたら DB 側の実行も止めて、`AbortError` を投げる。
- `QueryRequest.intent` はデモ接続が SQL を解釈せずに結果を作るための情報で、実際のドライバは使わない。

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
   - ~~セットフィルタの候補値の SQL（`SELECT DISTINCT` ＋件数上限。ほかの列の条件で絞る）~~ 済み（`filterOptions.ts`、§6）
   - ~~段階2のベースSQL の包み込み~~ 済み（`baseSql.ts`、§5 段階2、D-17）
   - ~~spreadsheet-grid への機能追加（D-12）は datasheet-grid リポジトリで進める~~ 済み（v0.41.0、§11.5）
6. ドライバのアダプタ、拡張本体、Webview の順に進める。Webview は spreadsheet-grid 0.41.0 以上を使う（D-14）。
   - ~~拡張本体と Webview の土台~~ 済み（デモ接続で、接続の追加 → ツリー → テーブルを開く → フィルタ → SQL プレビュー → 実行 → 取得・中止・上限、まで動く。§12）
   - 残り（段階1）：列の意味型の上書き（日付など）とその候補の提案、キーの上書き、段階2の画面（ベースSQL を開く、`checkBaseColumns`）
   - ドライバ（driver-mssql / driver-oracle）は、O-02 / O-03 の確認が済んでから作る。今は接続を追加できるが、開くと「ドライバはまだ実装していません」と出る

## 11. spreadsheet-grid の調査結果（O-04、v0.40.0）

> §11.1〜11.4 は **v0.40.0 時点**の調査。§11.3 の不足は v0.41.0 で解消済み（§11.5）。

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

- npm に公開済み（調査時 `@ishibashi0112/spreadsheet-grid@0.40.0`。現在は 0.41.0 が最新）。ESM と CJS の両方を配布している。
- peer 依存は React 19。
- CSS は `import '@ishibashi0112/spreadsheet-grid/style.css'` で明示的に読み込む。
- SSRM をアダプタとして使う案（`getRows` で SQL を実行し、N 行をキャッシュして切り出して返す）では、グリッドがローカルで絞り込みもソートもしなくなる。ただし次の理由で採らない。
  - フィルタ変更から 300ms 後に `getRows` が呼ばれるので、「Enter で初めて DB に投げる」仕様と合わない。
  - 全件取得後にクライアント側でソートする使い方ができない。
  - D-03 とも合わない。

### 11.5 v0.41.0 での対応状況（2026-09-24）

D-12 の依頼（`docs/spreadsheet-grid-requests.md`）は **5 項目すべて v0.41.0 で対応され、npm に公開済み**（datasheet-grid の PR #4 / #5 / #6）。公開 API は追加のみで、既定値では v0.40.0 と同じ経路を通る。実装名は提案と違うので読み替える。

| §11.3 の不足 | v0.41.0 |
|---|---|
| 1. グリッド自身の絞り込みを止められない | `manualFiltering`（boolean、既定 false）。列フィルタもグローバルフィルタも評価しない。回避策は不要 |
| 2. 集合フィルタの候補値 | グリッド prop `getFilterOptions({ columnKey, column, columnFilters（自列を除く他列）, globalText, signal }) => Promise<{ options, truncated? }>`。開くたびに取得・閉じると abort・ライブラリはキャッシュしない。読み込み中 / 失敗（再試行）/ 打ち切りの表示あり。反転（exclude）可 |
| 3. ソート | `manualSorting`（boolean、既定 false）。再マウント不要で切り替え可。`enableSorting={false}` で既存ソートが外れない件は既存仕様のまま |
| 4. 日本語入力 | 修正済み（変換中の Enter / Escape を無視。textSet の条件値は `compositionend` で 1 回だけ送る） |
| （便利機能）変更通知 | `onFiltersChange(filters)` / `onSortChange(sort)`。該当スライスが実際に変化したときだけ発火 |

- 5（`yyyymmdd`）と 6（ストリーミング）は依頼していない。方針は §11.3 のまま。
- `getFilterOptions` の候補 SQL（`SELECT DISTINCT` ＋件数上限＋他列条件で絞る）は core に実装済み（`buildFilterOptionsQuery` / `toFilterOptions`、§6）。`truncated: true` を返せば popover に「先頭のみ・打ち切り」が出る。
- `onStateChange` を自前で前回値と比較する処理は不要になった（`onFiltersChange` / `onSortChange` が差分判定済み）。

確認（2026-09-24）：npm の 0.41.0（react / core）の tarball に上の API が入っていること、datasheet-grid で v0.41.0 に追加されたテスト（7 ファイル、75 件）が通ることを確かめた。

Webview で使うときの注意点（ライブラリの不具合ではなく、使う側で気をつけること）：

- **グローバルフィルタ**：既定は `enableGlobalFilter = true` で、上部バーに検索欄が出る。`manualFiltering` では入力しても何も起きないので、`false` にする（D-15）。
- **候補を打ち切ったときの「全部チェック」**：表示中の候補を全部チェックすると、グリッドはフィルタの解除として扱う（`filterPopoverCommands.ts` の `commitSetFilterSelection`。選んだ数が候補数以上なら解除）。候補を打ち切っていると、画面に出ていない値の行まで結果に入る。上限は 1 万件（D-16）なので、手で全部チェックすることはまずなく、実害は小さいと見ている。問題になったら、打ち切り時は解除にしないようライブラリに相談する。
  - 全選択の状態から外していく操作は `exclude`（`NOT IN`）になり、候補の外の値は残る。これは依頼どおりの動き。
- **候補の検索欄**：検索するのは取得済みの候補だけで、DB に再取得はしない。値の種類が多い文字列の列では、条件（含む・前方一致など）で絞れるように、文字列の列は `textSet`（条件＋値の選択）にしておく（提案）。

## 12. 開発の手順（2026-09-24）

- 確認：`pnpm lint`、`pnpm typecheck`、`pnpm test`（core と host の単体テスト）。
- **開発用ページ**（ブラウザで画面を確かめる）：`pnpm --filter @sql-editor-tool/webview dev:build` のあと、`packages/webview/dev/index.html` をブラウザで開く。ホスト側の制御とデモ接続を同じページの中で動かす。クエリで切り替えられる（`?table=CUSTOMERS&dialect=oracle&maxRows=5000`）。
- **拡張のビルド**：`pnpm --filter sql-editor-tool build`（`packages/extension/dist/` に拡張本体と Webview を出力）。VS Code で `packages/extension` を拡張開発ホストとして開けば試せる。
- **vsix**：`pnpm --filter sql-editor-tool package:vsix`（`releases/` に出力。コミットしない）。会社 PC の VS Code に入れれば、デモ接続で動きを確かめられる。
- デモ接続は架空のデータ（受注・得意先・品目と、ビュー 1 つ）で、社内のテーブルとは関係ない。SQL は作るが、条件で行を絞り込まない（並べ替えと件数の上限だけ効く）。画面にもその旨を出している。
- Webview の注意点（実装して分かったこと）：
  - グリッドの `height="100%"` は内側のスクロール領域に当たる。外枠（`.ssg-root`）を縦の flex にし、`.ssg-shell` を伸ばさないと全行が描画される（仮想スクロールが効かない）。`packages/webview/src/styles.css` で対応済み。
  - 列メニューのボタンは、ヘッダにマウスを乗せたときだけ操作できる（自動操作で確かめるときは hover が要る）。
  - 行の高さは `density="compact"`。文字列の列は `textSet`、数値は `numberSet`、日付型と意味型が日付の列は `dateSet`。主キーの列は見出しに 🔑 を付ける。
- 設定：`sqlEditorTool.maxRows`（既定 10 万、D-11）、`sqlEditorTool.filterOptionsLimit`（既定 1 万、D-16）。設定名とコマンド名の接頭辞 `sqlEditorTool` は仮称（D-13）。名前が決まったら置き換える。
