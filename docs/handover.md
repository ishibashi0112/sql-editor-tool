# 引き継ぎ資料：A5:SQL Mk-2 代替 GUI 検索ツール（仮称未定）

最終更新：2026-09-26（ドライバ（driver-mssql / driver-oracle）を作り、拡張から使えるようにした。D-07 を更新し、D-22〜D-24、O-11 を追加。会社 PC での確認手順を §14 に置き、SQL Server の確認結果を記録した（O-03、O-11 を解決）。ユーザーの判断で、取得した行の絞り込みを画面ですぐに行う形に変え（D-25）、SQL＋フォーム（D-26）と Hayami の考えの取り込み（D-27）を決めた。Hayami の設計の要点を §15 に置いた。D-25 を会社 PC で確かめ（§14.2）、パラメータの書き方を `:名前` に決め（D-28）、レポートの保存と呼び出し方を決めた（D-29、§16）。§16 の 1（core）を作り、サイドバーにテーブル検索を追加した（D-30）。§16 の 2・3（レポートの画面と呼び出し）を作った（D-31）。O-14 を追加。§16 の 4（相対の日付の既定値、選択肢、SQL Server での入力欄の種類の推定）を作った（D-32〜D-35）。D-24 に推定の例外を追記し、O-13 を解決、O-15 を追加。段階1の残り（列の意味型の上書き・キーの指定・日付らしい列の案内）を作った（D-36・D-37）。Docker の Oracle でドライバを確かめ、不具合を 2 つ直し、Oracle のレポートの文字列を CHAR でバインドするようにした（D-38、§14.4）。すべての .sql で、テーブル名・列名・キーワードの入力補完を作った（D-39））

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
| SQL Server | 2012 SP2（11.0.5058）Standard Edition。照合順序はサーバー・DB とも `Japanese_CI_AS` | 確定（§13）。Node.js からの接続は未確認（O-03） |
| Oracle | 19c（19.19）Standard Edition 2。文字コード `JA16SJIS`、`NLS_LENGTH_SEMANTICS = BYTE` | 確定（§13）。Thin モードでの接続は未確認（O-02） |
| 外部キー | SQL Server は 0 件。Oracle は 7 件あった（少数なので、関係の手動登録（段階3）の方針は変えない） | 確定（§13） |
| 主キー | 複合主キーのテーブルが多い（SQL Server は最大 10 列、Oracle は最大 16 列）。主キーのないテーブルも多い（SQL Server 305、Oracle 42。多くはバックアップや作業用） | 確定（§13） |
| 日付の持ち方（SQL Server） | `yyyymmdd` 形式の文字列（Hayami の知見）が主。ほかに `date` / `datetime` 型、長さ 10・14・17 の文字列、numeric もある | 確定（§13）。`yyyymmdd` 以外の書式は O-10 |
| 日付の持ち方（Oracle） | DATE 型（96 列）と VARCHAR2(10) / (20) の文字列が混在。長さ 8 の文字列はない | 一部確定（§13）。時刻の使用は O-01、文字列の書式は O-10 |
| vsix | 会社 PC の VS Code に自作拡張をインストールできることを確認済み | 確定 |
| VS Code（会社 PC） | 1.101 以降（内蔵の Node は 22） | 確定（ユーザーの回答、D-22） |
| ネットワーク | DB は社内ネットワークからのみ到達可能。Mac からは接続できない | 確定 |

開発は Mac（Claude Code）で行い、DB に繋ぐ検証は会社 PC で行う。検証結果は、ホスト名・IP・DB 名・業務データをマスクしてから持ち帰る。

## 3. 決定事項

| No | 内容 | 状態 |
|---|---|---|
| D-01 | ホストは VS Code 拡張で進める | 確定 |
| D-02 | 結合は ANSI 形式（`JOIN ... ON`）のみ扱う。Oracle 独自の `(+)` 記法は扱わない | 確定 |
| D-03 | 段階1は SSRM を使わない。「条件はサーバー（WHERE 句）、行はクライアント（上限つき全件取得）」の構成にする | 変更（D-25）。SSRM を使わず上限つきで全件取得するのは同じ。条件は、通常は画面（グリッド）で絞り込み、WHERE にするのは「DB から取り直す」ときだけにした |
| D-04 | 段階的に進める：段階1＝単一テーブル／ビュー、段階2＝ベースSQL＋GUIフィルタ、段階3＝関連テーブル条件（EXISTS） | 提案（概ね合意） |
| D-05 | 読み取り専用。生成・実行するのは SELECT（と WITH）のみ | 提案（概ね合意） |
| D-06 | DB 上の型と「意味上の型」を分けて持つ（例：VARCHAR(8) だが意味は日付） | 提案（実装済み。設定の画面は D-36） |
| D-07 | ドライバは SQL Server が tedious（`mssql` を通さず直接使う。Hayami と同じ）、Oracle が `node-oracledb` の Thin モード（設定で Thick モードに切り替えられる。D-21） | 提案（実装済み、2026-09-26）。tedious を直接使うのは、`mssql` を通しても decimal の精度の問題（D-23）は変わらず、Hayami の実装を参考にできるため。接続のプールは自前（`driver-mssql/src/pool.ts`） |
| D-08 | モノレポ構成で、core（方言・WHERE 生成・スキーマモデル）をホスト非依存にする | 提案（概ね合意） |
| D-09 | Hayami の D-14 セキュリティ原則を引き継ぐ（§8） | 提案 |
| D-10 | コーディング規約は Hayami 寄り：pnpm モノレポ、Biome（2 スペース、ダブルクォート、recommended）、TS strict＋`noUncheckedIndexedAccess`＋`exactOptionalPropertyTypes`＋`verbatimModuleSyntax`、`.gitattributes` で LF 固定、日本語コメント。テストは vitest（拡張は Bun ではなく VS Code 内蔵の Node で動くため） | 確定（O-06） |
| D-11 | 取得上限の既定値は 10 万行（設定で変更可） | 確定（O-07） |
| D-12 | spreadsheet-grid に足りない機能（§11.3）はライブラリ側に追加する。依頼内容は `docs/spreadsheet-grid-requests.md`。ライブラリが対応するまで、アプリは回避策（`filterFn: () => true`）で進める | 確定（O-08）。**対応済み**：v0.41.0 で全項目が入り npm に公開された（2026-09-24、§11.5） |
| D-13 | 名前が決まるまで、パッケージは仮称 `@sql-editor-tool/*` で作り、決まったら置き換える | 確定 |
| D-14 | Webview は `@ishibashi0112/spreadsheet-grid` **0.41.0 以上**を使い、回避策（全列の `filterFn: () => true`）は使わない。`manualFiltering` / `manualSorting` / `onFiltersChange` / `onSortChange` / `getFilterOptions` を使う（実装名は提案と違う。読み替えは §11.5 と `docs/spreadsheet-grid-requests.md` の対応表） | 確定。D-25 で `manualFiltering` / `manualSorting` / `getFilterOptions` は使わなくなった（グリッドが自分で絞り込み・並べ替え・候補の収集をする）。`onFiltersChange` / `onSortChange` は、SQL プレビューと「取り直す」のために使う |
| D-15 | 段階1では、グリッドのグローバルフィルタ（上部バーの検索欄）を使わない（`enableGlobalFilter={false}`）。`manualFiltering` ではグリッドが絞り込まず、core も `globalText` を WHERE にしないので、入力しても何も起きないため。全列の LIKE を OR で繋ぐ案は、インデックスが効かず重いので見送る | 確定（当面）。D-25 の後は検索欄も画面で効くようになるが、WHERE にできないので「画面の絞り込み＝SQL プレビュー」が崩れる。そのため使わないままにしている。要望があれば見直す |
| D-16 | 集合フィルタの候補値は、DB から `SELECT DISTINCT` に件数上限をかけて取得する（§6）。上限の既定値は 1 万件（Excel の候補表示と同じ。設定で変更可）。グリッドの候補リストは仮想化されているので、1 万件でも表示できる | 変更（D-25）。候補はグリッドが取得済みの行から作る。設定 `filterOptionsLimit` とホスト側の候補の取得は削除した。core の `buildFilterOptionsQuery` は、フォームの選択肢（D-26）などに使えるので残す |
| D-17 | ベースSQL は「1 つの SELECT / WITH 文で、バインド変数を含まないもの」に限る。SQL Server では、最上位の ORDER BY は TOP か OFFSET があるときだけ使える（派生テーブルの制約）。並べ替えは列見出しで指定する（§5 段階2） | 見直し予定（D-26）。フォームの値をバインド変数として SQL に埋め込むので、「バインド変数を含まない」の制限は外す |
| D-18 | DB への実行は「実行」ボタンを押したときだけ。キー操作（§5 の Enter キー、Ctrl+Enter）では実行しない。Enter はグリッドのセル移動やフィルタの確定と重なるため | 確定。D-25 の後も、DB に問い合わせるのはボタン（「実行」と「今の絞り込みで DB から取り直す」）だけ。画面の絞り込みはすぐ効く |
| D-19 | 行は「行ごとの配列」（`CellValue[][]`）のチャンクで Webview に送る。§5 の「列ごとの配列」から変える。グリッドの `getValue: row => row[i]` でそのまま読め、行オブジェクトへの変換が要らないため。Webview は受け取った行を 200ms ごとにまとめて画面に反映する | 確定（当面） |
| D-20 | VS Code に依存しないアプリ層を `packages/host` に置く（Webview とのメッセージ、ドライバのインターフェイス `DbSession`、データビューの制御 `DataViewController`、デモ接続）。拡張はこれを VS Code につなぐだけにする。ブラウザの開発用ページでも同じ制御を動かせる（§12） | 確定 |
| D-21 | 接続確認を待たずにドライバを作る。SQL Server は Node.js（tedious、`encrypt: false`）からの接続実績があるので確認済みとみなす。Oracle は Thin モードで接続できる想定で作り、会社 PC で初めて繋いだときに確かめる。繋がらなかった場合は Thick モード（会社 PC にある Oracle Client を使う）に切り替えられるよう、接続設定に切り替えを用意しておく | 確定（ユーザーが判断）。切り替えは設定 `sqlEditorTool.oracle.clientMode`（§12）。Thin / Thick は 1 つのプロセスで 1 回しか決められないので、接続ごとではなく拡張全体の設定にした |
| D-22 | 対象は VS Code 1.101 以降（`engines.vscode` は `^1.101.0`、esbuild の対象は Node 22）。tedious 20 が Node 22 以上を求めるため | 確定（会社 PC は 1.101 以降、ユーザーの回答） |
| D-23 | 15 桁を超える数値を正確に扱う（§13 の結果による）。取得：SQL Server は 16 桁以上の decimal / numeric を SELECT で `CONVERT(varchar(40), 列) AS 列` にして文字列で取る（`ColumnType` の `asText`。tedious は decimal を JavaScript の数値で読むため）。Oracle は精度の指定がない NUMBER と 16 桁以上の NUMBER を `fetchTypeHandler` で文字列にする。バインド：桁数で型を選ぶ（SQL Server は int / bigint / decimal(p, s)、15 桁を超える小数は varchar。Oracle は NUMBER、15 桁を超えれば文字列）。§6 | 提案（実装済み） |
| D-25 | 取得した行の絞り込みと並べ替えは、画面（グリッド）ですぐに行う（Excel と同じ）。「実行」は条件なし・主キーの順で、上限まで取得する。上限で打ち切ったときは「画面の絞り込みは取得した行だけが対象」と案内し、「今の絞り込みで DB から取り直す」ボタンで、画面の絞り込みと並べ替えを WHERE と ORDER BY にして取り直す（それまでの WHERE 生成を使う）。DB で絞り込んで取った後に、その条件を外したり変えたりしたときも、同じ案内とボタンを出す。SQL プレビューは「画面の絞り込みと並べ替えを WHERE・ORDER BY にしたもの」で、コピーして A5 などで使える | 確定（2026-09-26、ユーザーが判断。「フィルタを変えるたびに SQL を実行し直すのは不自然」） |
| D-26 | フォーム：SQL を書くと、その中のパラメータから入力欄を自動で作り、入れた値をバインド変数として渡して実行する。SQL と入力欄の定義は名前を付けて保存し、使い回す（段階2を広げたもの。§5） | 確定（ユーザーが判断）。設計は §16（Hayami（§15）をもとに決めた。D-28〜D-35） |
| D-27 | Hayami の考え（SQL を登録 → パラメータの入力フォーム＋グリッド＋Excel 出力）を、このツール（VS Code、SQL Server と Oracle）に取り込む | 確定（ユーザーが判断）。取り込む範囲は段階2の設計で決める |
| D-28 | フォームのパラメータは `:名前` で書く（日本語の名前も可）。実行時に DB ごとの形に変える：SQL Server は `@名前`、Oracle はそのまま、将来の PostgreSQL は `$1`、MySQL は `?`（同じ名前は同じ値）。文字列・コメント・引用符つきの名前の中と、`::`（PostgreSQL の型変換、SQL Server の `geometry::Point` など）はパラメータとして扱わない | 確定（2026-09-26、ユーザーが「今後ほかの DB もサポートしたいので、多くで使えるもの」を条件に Claude の推奨を採用。O-12 を解決）。`:名前` は Oracle・SQLite がそのまま使え、A5:SQL Mk-2・DBeaver・Spring・JPA などのツールでも使われている。`@名前` は SQL Server の変数や MySQL のユーザー変数とぶつかる |
| D-29 | レポート（SQL＋フォーム）は `.sql` ファイルとして保存する。入力欄の設定と接続名は、同じファイルの先頭のコメントに書く（画面で直すと自動で書き込む）。保存先は「レポートのフォルダ」1 か所にまとめ、サイドバーの「レポート」一覧・コマンド「レポートを開く」・エディタの「レポートとして開く」ボタンから呼び出す（§16） | 確定（2026-09-26。ユーザーは Claude の推奨を採用し、「保存したものをすぐ呼び出せる導線、どこに保存したか分からなくならないように」を求めた） |
| D-30 | サイドバーの「接続」の上に「テーブル検索」のビュー（Webview）を置き、検索欄を常に出す。接続中の DB のテーブル名・ビュー名を部分一致で探し（全角半角・大文字小文字を区別しない。空白で区切った語はすべて含むもの。「スキーマ.名前」でも絞れる）、選ぶ（クリック、または ↑↓ と Enter）とデータビューを開く。一覧は接続を開いたときに `listAllObjects` で 1 回取り、入力のたびに画面の側で絞り込む（DB には問い合わせない）。未接続の接続は「接続」ボタンで開ける。「最新の情報に更新」で一覧を取り直す | 確定（2026-09-26。ユーザーが「テーブルを開くまでの検索欄が欲しい」と要望し、プレビューの 2 案から「サイドバーに常に検索欄」を選んだ） |
| D-31 | レポートの画面は、上にフォーム（入力欄を横に並べ、入りきらなければ折り返す）、その下に結果。入力欄の設定（表示名・種類・必須・既定値）は「⚙ 入力欄」で一覧の表にしてまとめて直し、保存すると `.sql` の先頭のコメントに書く。フォームの入力欄の中の Enter で実行する（変換を確定する Enter は除く）。D-18 の「キー操作では実行しない」はグリッドのセル移動やフィルタの確定と重なるためで、フォームの入力欄には当たらないと判断した | 確定（2026-09-26、ユーザーがプレビューの 2 案ずつから選んだ）。Enter で実行するのは Claude の判断。不要なら外す |
| D-32 | レポートの日付の入力欄の既定値に、相対の日付を書ける。基準（今日・月初・月末・年初・年末・年度初・年度末）に、±N日・±Nか月・±N年を付ける（例：`今日-7日`、`月初-1か月`）。別名：本日・昨日・明日・今月初・今月末・前月初・前月末・翌月初・翌月末。年度は 4 月始まり。か月・年の増減を先に当てて基準の日を決め、そのあと日の増減を当てる（`月末-1か月` は前月の末日。`今日-1か月` で月末を越えるときはその月の末日）。全角の数字や記号、空白も読む。日付の種類（date / ymd）の入力欄だけに効く | 確定（2026-09-26、ユーザーがプレビューの 2 案から「基準＋増減」を選んだ）。実装は `core/src/relativeDate.ts` |
| D-33 | 相対の既定値を持つ入力欄は、レポートを開くたびに既定値から計算して入れる（前回の値は使わない。昨日の日付が残らないように）。ほかの入力欄は、これまでどおり前回の値を入れる。開いたままで SQL や設定を書き換えたときは、入力した値を残す | 確定（2026-09-26、ユーザーが 3 案から選んだ） |
| D-34 | 選択肢：入力欄の種類に「選択肢」（`select`）を足す。候補は SQL（`options`。1 列目＝値、2 列目＝表示名。Hayami と同じ）で、レポートを開いたときに取る（上限 1 万件、同じ値は 1 つにまとめる、値が空の行は除く）。入力欄は「打って絞れるリスト」：打つと値か表示名にその文字を含む候補に絞られ（全角半角・大文字小文字を区別しない。空白で区切った語はすべて含むもの）、↑↓ と Enter かクリックで選ぶ。一覧に出すのは 100 件まで。一覧は打ったとき・クリックしたとき・↓↑ で開く（フォーカスだけでは開かない。Tab で移って Enter で実行できるように）。SQL には文字列で渡す。候補にない値を打ったときは、打った文字を渡す。必須でなければ空にでき、NULL を渡す。候補の SQL の中の `:名前`（ほかの入力欄の値で候補を絞る）は、まだ使えない | 確定（2026-09-26、ユーザーがプレビューの 2 案から選んだ）。一覧の細かい動きは Claude の判断 |
| D-35 | SQL Server では、種類を設定していない入力欄の種類を `sp_describe_undeclared_parameters` で推定する。レポートを開いたとき・SQL を書き換えたときに自動で行う（未接続なら接続する。同じ接続・同じ SQL では推定し直さない）。推定した種類はファイルに書かず、「⚙ 入力欄」で「（推定）」と出し、保存したときに書く。推定の仕方：`:名前` を出現ごとに別のバインド変数にする（同じ名前の 2 回目でエラー 11508 になるため）。`:名前 IS [NOT] NULL` の出現は int と推定されるので、推定しない変数として `@params` で宣言する。推定できない出現（`COALESCE(:名前, 列)` はエラー 11502 など）があると全体が失敗するので、エラーが挙げた変数を宣言に回して推定し直す。それ以外のエラー（SQL の誤りなど）なら推定しない。型の対応：数値型→数値、date / datetime 系→日付、文字列→文字列。ただし yyyymmdd の文字列の列と `>=` で比べると `nvarchar(4000)` と推定されるので、文字列で長さが 8 か分からない（4000 以上）もので、名前が日付らしい（「日」「YMD」「DATE」を含む、「DT」で終わる。日数・曜日などは除く）ものは yyyymmdd の日付にする。Oracle は推定しない（文字列から始めて利用者が直す。O-13） | 確定（2026-09-26、ユーザーが「開いたときに自動」を選んだ）。推定の細部は Claude の判断。SQL Server 2022（Docker）で確かめた。2012 での確認は O-15 |
| D-36 | データビューの列の設定：上部の「⚙ 列」で一覧の表（列名・DB の型・意味・キー）を開き、まとめて直して保存する（レポートの「⚙ 入力欄」と同じ形）。意味は文字列の列だけ「そのまま（文字列）」か「日付（yyyymmdd）」を選べる（日付にすると、列見出しで期間などの日付の絞り込みが使え、DB には yyyymmdd の文字列で問い合わせる）。キーは主キーのないテーブル・ビューだけ指定でき、取得の順（ORDER BY）と 🔑 の表示に使う（主キーがあれば主キーを使い、変えられない）。保存先は VS Code の globalState（この PC だけ）で、接続名・スキーマ・テーブルごと（接続の ID は PC ごとに違うので、レポートと同じく名前で結び付ける）。保存すると、列の種類が変わって絞り込みと形が合わなくなるので、画面の絞り込みと並べ替えを外して作り直す（取得した行は残す） | 確定（2026-09-26、ユーザーがプレビューの 2 案から「⚙ 列」を選んだ）。保存先・キーの順・保存時に絞り込みを外すのは Claude の判断。グリッドの列メニューには項目を足せない（列見出しの描画を差し替えられるだけ）ため、列ごとのメニューにはしなかった |
| D-37 | 日付らしい列の案内：列の設定を一度も保存していないテーブルを開いたとき、yyyymmdd の日付らしい列（長さ 8 の文字列で、名前が日付らしいもの。判定は D-35 と同じ `looksLikeDateName`）があれば、上に案内を出す。「日付として扱う」でまとめて日付にして保存、「⚙ 列で選ぶ」で表を開く（候補を日付にした状態から始め、「（候補）」と出す）、「使わない」でそのテーブルではもう案内しない | 確定（2026-09-26、ユーザーが 3 案から選んだ） |
| D-38 | Oracle のレポートの文字列の入力欄（と選択肢）は、CHAR（`DB_TYPE_CHAR`）でバインドする（方言の `reportText`）。NVARCHAR では VARCHAR2 列の索引が効かず（全件を読む）、VARCHAR / NVARCHAR では CHAR 列と一致しない（`得意先コード = :得意先` が 0 件）。CHAR なら A5:SQL Mk-2 で値を直に書いたときと同じく空白を埋めて比べ、VARCHAR2 の索引も効く。SQL Server はこれまでどおり NVARCHAR（社内の列はほぼ nvarchar）。テーブルの絞り込み（WHERE 生成）は列の型が分かるので、これまでどおり列に合わせる | 確定（2026-09-26、Claude の判断。Docker の Oracle で、一致する件数と実行計画を確かめた。§14.4）。DB の文字コード（JA16SJIS）にない文字は CHAR では送れないが、そのような文字は VARCHAR2 の列にも入らないので影響は小さい |
| D-39 | .sql の入力補完（レポートに限らず、VS Code で開くすべての .sql）。「テーブル.」「別名.」「スキーマ.テーブル.」の後に、そのテーブルの列（テーブルの列の順、型つき、主キーは 🔑）。FROM・JOIN の後（FROM の , の後も）に、テーブル・ビュー・スキーマ。「スキーマ.」の後に、そのスキーマのテーブル。それ以外の位置は SQL のキーワード（方言ごとの関数なども）。文字列・コメントの中では出さない。ドットのない列名の補完はしない（候補が多くなりすぎるため、ユーザーが選ばなかった）。補完に使う接続：レポートの .sql（先頭に設定のコメントがある、またはレポートのフォルダの中）は先頭のコメントの接続。それ以外の .sql は、ステータスバーの「接続を選ぶ」で選び、ファイルごとに VS Code の中（globalState）に覚える。レポートでステータスバーから選び直すと、先頭のコメントに書く。未接続なら補完のときに接続する。テーブルの一覧と列は接続ごとに覚えておき、「最新の情報に更新」・切断・接続の追加や変更で捨てる | 確定（2026-09-26、ユーザーが要望し、補完の範囲・接続の選び方・未接続のときを選んだ）。細部は Claude の判断：名前は大文字小文字を区別せずに比べる。同じ名前のテーブルが複数のスキーマにあれば「スキーマ.名前」で入れる。予約語・空白・記号を含む名前と、Oracle で小文字を含む名前は引用符で囲んで入れる。別名は、カーソルのある文（; と GO の行で区切る）の FROM・JOIN から読む。派生テーブル・WITH の名前・テーブル値関数の列は分からないので出さない。FROM に書く前でも「テーブル名.」なら列を出す。書きかけの SQL でも判定できるよう、字句の読み方は `baseSql.ts` とは別の緩いもの（`core/src/completion.ts`） |
| D-24 | 読み取り専用の最後の確認として、ドライバは DB に送る直前に `assertReadOnlyQuery`（core）を呼ぶ。SELECT / WITH で始まる 1 つの文で、書き込みなどの語（INSERT、UPDATE、DELETE、MERGE、INTO、CREATE、ALTER、DROP、TRUNCATE、GRANT、REVOKE、EXEC）がないことを確かめる。Oracle の `SET TRANSACTION READ ONLY` は使わない（SELECT / WITH 以外を送らない原則のため） | 提案（実装済み）。**例外**（D-35）：入力欄の種類の推定のため、決まった文 `EXEC sys.sp_describe_undeclared_parameters @tsql = @tsql, @params = @params` だけは送る（`driver-mssql` の `DESCRIBE_PARAMS_SQL`）。この手続きは SQL を解析するだけで実行しない。利用者の SQL は `@tsql` の値として渡し、その SQL にも `assertReadOnlyQuery` をかける。CLAUDE.md の「SELECT / WITH のみ」は書き換えず、この例外は D-24 の記録だけにする（2026-09-26、ユーザーが選んだ） |

## 4. 未確定事項

| No | 内容 | 確認方法 | 状態 |
|---|---|---|---|
| O-01 | Oracle 側の日付は DATE 型か、`yyyymmdd` 文字列か。DATE 型なら時刻部分を使っているか | `verify/` の SQL で確認 | 一部確認（§13）：両方ある（DATE 96 列、日付らしい VARCHAR2(10) / (20) が約 220 列）。DATE の時刻の使用は未確認（`manual/date_time_usage.sql` を代表的な列で実行する） |
| O-02 | Oracle に node-oracledb の Thin モードで接続できるか（バージョン、パスワード方式、ネイティブネットワーク暗号化の要否） | `verify/oracle-run.mjs` | 一部確認：19.19 は Thin モードの対象。`JA16SJIS` も Thin モードではサーバー側で変換される（node-oracledb の文書）。接続そのもの（パスワード方式、暗号化の要否）は未確認。接続できる想定で進める（D-21）。ドライバを会社 PC で初めて使うときに確かめる（§14）。繋がらなければ設定で Thick モードに切り替える。Docker の Oracle 23ai Free（AL32UTF8）では、Thin モードでの接続・メタデータ・型の変換・絞り込み・中止・レポートが動くことを確かめた（§14.4。社内の 19c・JA16SJIS・パスワード方式・暗号化は別） |
| O-03 | SQL Server のバージョンの確定と、VS Code 内蔵 Node.js（Bun ではない）で `encrypt: false` の接続ができるか | `verify/mssql-run.mjs` | 解決：バージョンは 2012 SP2（§13）。拡張（VS Code 内蔵の Node、tedious、`encrypt: false`）から接続できた（2026-09-26、§14.1） |
| O-04 | spreadsheet-grid に「クライアント行モデルのまま、フィルタ操作を記述子として外に通知するだけで、グリッド自身では絞り込まない」モード（外部フィルタモード）があるか。なければライブラリ側に追加 | spreadsheet-grid のコードを確認 | 確認済み：v0.40.0 には**ない**（§11）→ v0.41.0 で `manualFiltering` として追加された（§11.5、D-14） |
| O-05 | プロダクト名（リポジトリ名）。将来 A5 のような汎用 SQL エディタに育つ可能性もあるので、「フィルタ」に限定しない名前がよい。好み：短いローマ字の日本語で、掛け言葉になっている日常語 | ユーザーが決定 | 未確定。キープ：kumu（汲む／組む）、hikidashi（引き出し）。見送り：shiboru、saguru、shirabe、sukuu、tansu、hishaku、tsurube、ami、taguru、ukagau、yomu、furui、hikiami、mekuru、toru |
| O-06 | コーディング規約（Biome、TS strict、改行コード、日本語コメントなど）。既存の spreadsheet-grid / Hayami に合わせるか | ユーザーが決定 | 解決（D-10） |
| O-07 | 取得上限の既定値。提案は 10 万行（設定で変更可） | ユーザーが決定 | 解決（D-11） |
| O-08 | spreadsheet-grid に足りない機能（§11.3）を、ライブラリ側に追加するか、アプリ側の回避策で済ませるか | ユーザーが決定 | 解決（D-12） |
| O-09 | 文字列比較の細部。(1) 大文字小文字：グリッドのクライアント側判定は区別しない。SQL Server は照合順序次第（多くは区別しない）、Oracle は既定で区別する。Oracle で区別しないようにすると `UPPER(col)` でインデックスが効かなくなる。(2) 空白だけの値：グリッドは空欄として扱う。SQL Server の `col = ''` は末尾空白を無視するので一致するが、Oracle の `col IS NULL` は一致しない（CHAR 列に空白を入れて「空」としている運用がないか）。(3) Oracle の CHAR 列の `RPAD(:p, 列長)`：RPAD の長さは表示幅なので、全角文字を含む値や BYTE 単位の列長で合わない可能性がある。node-oracledb で `DB_TYPE_CHAR` としてバインドする案もある（レポートでは採用した。D-38） | 会社 PC で確認（O-03 の照合順序、`verify/` の型の分布、CHAR 列での実際の比較）。(1) はその結果を見てユーザーが決定 | 一部確認（§13）：SQL Server は `Japanese_CI_AS`（大文字小文字・全角半角・ひらがなカタカナを区別しない）。Oracle の CHAR 列は 12 列だけ、NLS_LENGTH_SEMANTICS は BYTE なので、(3) の影響は小さい。(1) の方針は未決定 |
| O-10 | 文字列（と数値）で持つ日付の書式。`yyyymmdd` 以外に、SQL Server の nvarchar(10) / (14) / (17) と numeric の日付らしい列、Oracle の VARCHAR2(10) / (20) がある。区切り付き（`yyyy/mm/dd`）や時刻付き（`yyyymmddhhmmss`）なら、意味型（D-06）に書式を持たせる必要がある | 代表的な列で `verify/sql/*/manual/string_date_format.sql` を実行し、書式（数字を 9 に置き換えた形）を持ち帰る | 未確定 |
| O-12 | フォームのパラメータの書き方。Hayami は全 DB で `@名前` に統一（Hayami の D-3・D-20）。Oracle と A5:SQL Mk-2 では `:名前` が普通。どちらで書くか（両方を受け付けるか） | 段階2の設計でユーザーが決定 | 解決（D-28）：`:名前` |
| O-13 | Oracle のパラメータの型の決め方。SQL Server は `sp_describe_undeclared_parameters` で推定できる（Hayami で実績あり、ただし失敗も多い）。Oracle には相当するものがない | 段階2の設計で決める。Hayami の「名前の抽出＋既定の型（文字列）＋利用者が上書き」が受け皿になる | 解決（§16、D-35）：Oracle は文字列から始めて、利用者が「⚙ 入力欄」で直す |
| O-15 | SQL Server 2012 SP2 での `sp_describe_undeclared_parameters` の結果が、2022 で確かめた結果（D-35）と同じか。特に、`:名前 IS NULL` が int になること、yyyymmdd の列と `>=` で比べたときの `nvarchar(4000)`、推定できない出現のエラー（11502 など）のメッセージに `@p1` の形で変数名が入ること（日本語のメッセージでも） | 会社 PC で 0.5.0 のレポートを開き、入力欄の種類が期待どおりになるかを見る（§14.3） | 未確定 |
| O-14 | SQL Server のレポートの結果に 16 桁以上の decimal / numeric があると、下の桁が狂う。テーブルを開くときは列の型が先に分かるので SELECT で文字列に変換しているが（D-23）、レポートは利用者の SQL の結果をそのまま受け取るため変換できない。案：`sp_describe_first_result_set` で先に列の型を調べ、該当する列があれば SQL を包んで変換する（その場合、SQL Server の ORDER BY は外側に付け直す必要がある） | 16 桁以上の値を扱うレポートが実際にあるかをユーザーが確かめる | 未確定 |
| O-11 | SQL Server 2012 SP2（11.0.5058）へのログインの TLS。tedious は `encrypt: false` でもログインの間は TLS を使う。この版は TLS 1.2 に対応する更新より前の可能性があり、VS Code 1.101 の Node 22 の既定（TLS 1.2 以上）では失敗するかもしれない | 会社 PC で拡張から接続する（§14）。TLS のエラーなら設定 `sqlEditorTool.mssql.tlsMinVersion` を `TLSv1` にして再試行する | 解決：設定を変えずに（既定の TLS 1.2 以上のまま）接続できた（2026-09-26、§14.1）。設定は残しておく |

## 5. 段階計画

> 2026-09-26 に方針を変えた（D-25〜D-27）。段階1の「フィルタ → WHERE → 実行」は、「実行で取得 → 画面ですぐ絞り込む（上限で打ち切ったときだけ WHERE にして DB から取り直す）」に変えた。段階2は「SQL＋フォーム（Hayami の考えを取り込む）」に広げる。以下の段階1・2の記述のうち、これと食い違うところは D-25〜D-27 が優先する。

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
- **列の意味型の上書き**：テーブル・列ごとに意味型（日付など）を指定して保存する。長さ 8 の文字列列で、名前が「〜日」「〜YMD」「〜DATE」などのものは候補として提案し、確定はユーザーが行う。（済み。D-36・D-37。意味型は yyyymmdd の日付だけ。ほかの書式は O-10 の結果を見て足す）
- **キーの上書き**：主キーのないテーブルやビューでは、ユーザーがキー列を指定して保存できる。（済み。D-36）

### 段階2：ベースSQL＋GUI フィルタ → SQL＋フォーム（D-26、D-27）

- 2026-09-26 の方針（D-26・D-27）：SQL を書く → SQL の中のパラメータから入力欄を自動で作る → 値を入れて実行（値はバインド変数）→ 結果は画面ですぐ絞り込める（D-25）→ SQL と入力欄の定義を名前を付けて保存する。設計は Hayami（§15）をもとに決める。以下の「ベースSQL」の包み込みは、上限で打ち切ったときに画面の絞り込みを WHERE にして取り直すところで使う。

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
  - 読み取り専用を守る仕組みは、派生テーブルで包むこと（中には問い合わせしか書けない）。字句の検査は、DB のエラーより分かりやすいメッセージを出すためのもの。ドライバは実行の直前に `assertReadOnlyQuery` で確かめる（D-24）。さらに守るなら、両方の DB で参照権限だけのアカウントを使う。

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
- **SQL Server のバインド型**：文字列パラメータを NVARCHAR で送り VARCHAR 列と比較すると、暗黙の型変換でインデックスが効かなくなることがある。列が varchar / char なら VARCHAR、nvarchar / nchar なら NVARCHAR でバインドする（`ParamType` の `unicode`。長さは tedious が値から決める）。
- **数値の精度**：Oracle の NUMBER や SQL Server の decimal で 15 桁を超えうる列は、JavaScript の数値に変換すると下の桁が狂う。文字列として取得する（D-23）。
  - SQL Server は tedious が decimal を数値で読むので、SQL の側で文字列にする（`SELECT` に列を並べ、その列だけ `CONVERT(varchar(40), 列) AS 列`）。該当の列がなければ `SELECT *` のまま。候補値の SQL は、文字列にした値と元の値の 2 列を取り、元の値で並べる（文字列の順だと 10 が 9 より前に来るため）。
  - バインドも tedious は decimal を数値で送るので、15 桁を超える小数は varchar で送り、SQL Server に列の型へ変換させる（列の位取りより細かい値は丸められる）。整数は bigint の範囲なら文字列のまま bigint で送れる。
- **セットフィルタの候補値**：DB から `DISTINCT` に件数上限をかけて取得する（D-16）。
  - ほかの列の条件で絞る。候補を取る列自身の条件は使わない（グリッドが取得した候補に当てる）。
  - 上限 + 1 件を取り、はみ出したら打ち切り（`truncated`）とする。
  - 空欄を先頭に並べる（Oracle は `NULLS FIRST`、SQL Server は昇順で NULL と空文字が先頭）。打ち切られても空欄は候補に残る。
  - 日付型の列は `CONVERT(char(8), col, 112)` / `TO_CHAR(col, 'YYYYMMDD')` で日単位の文字列にして取る。時刻を持つ列でも候補は日ごとになり、Date で受けたときのタイムゾーンのずれも起きない。
  - 結果は `toFilterOptions` で候補にする。NULL と空文字は `''`（ラベル `（空白）`）、日付は `'YYYY-MM-DD'`。その値をそのまま WHERE の生成に渡せる。
  - 列に索引がない大きいテーブルでは、`DISTINCT` が全件走査になる。所要時間は会社 PC で確かめる。
- **識別子**：列名・テーブル名は常に引用符で囲む（SQL Server は `[...]`、Oracle は `"..."`）。予約語や日本語の列名でも壊れないようにするため。
- **実装**：`packages/core/src/where.ts`（条件）、`select.ts`（SELECT 文）、`filterOptions.ts`（集合フィルタの候補値）、`baseSql.ts`（段階2のベースSQL）、`dialect.ts`（方言の差）、`readOnly.ts`（実行前の読み取り専用の確認、D-24）。SQL は `sql` タグ付きテンプレートで組み立て、値は `Param` としてしか埋め込めないようにしている。バインド版と A5 に貼るリテラル版は、同じ断片から出力する。

## 7. アーキテクチャ（提案）

pnpm のモノレポ。

```
packages/
  core/            方言、フィルタ記述子 → WHERE 句、スキーマモデル。依存なしの純 TypeScript。一番厚くテストする
  host/            VS Code に依存しないアプリ層（D-20）：Webview とのメッセージ、DbSession、DataViewController、デモ接続
  driver-mssql/    tedious のドライバ（DbSession の実装、接続のプール、型の対応、値の変換）
  driver-oracle/   node-oracledb のドライバ（DbSession の実装、Thin / Thick の切り替え、型の対応、値の変換）
  extension/       VS Code 拡張本体：接続の管理、ツリー、Webview パネル。host を VS Code につなぐ
  webview/         React＋spreadsheet-grid の画面。dev/ はブラウザで確かめる開発用ページ
```

- ドライバが守ること（`packages/host/src/session.ts`）：結果の列名を `onColumns` で先に渡す。行は数百〜数千行ずつ `onRows` で渡す。日付・時刻は `'YYYY-MM-DD HH:mm:ss'` などの文字列、15 桁を超えうる数値は文字列にする。`signal` が中断されたら DB 側の実行も止めて、`AbortError` を投げる。
- `QueryRequest.intent` はデモ接続が SQL を解釈せずに結果を作るための情報で、実際のドライバは使わない。
- ドライバの実装（2026-09-26）：
  - 接続を開くときに 1 本つないで確かめる（パスワードの誤りなどをツリーを開いた時点で出す）。接続は最大 4 本を使い回し、使われないまま 5 分過ぎたら閉じる。行の取得中でも、候補値の取得やツリーの展開を待たせないため。
  - 行の渡し方：SQL Server は 1000 行ごと、または前に渡してから 100ms で渡す（最初の行はすぐ出る）。Oracle は `getRows` で最初 100 行、あとは 1000 行ずつ。
  - 中止：SQL Server は `connection.cancel()`、Oracle は `connection.break()`（止めた接続はプールに戻さずに閉じる）。
  - 時間での打ち切りはしない（tedious の `requestTimeout: 0`）。止めるのは「中止」ボタンだけ。
  - 日付・時刻は `'YYYY-MM-DD HH:mm:ss'`（秒の小数部は 0 でなければ付ける）、date 型は `'YYYY-MM-DD'`。SQL Server は tedious が DB の値を UTC として Date にするので UTC で読む。Oracle は node-oracledb がローカル時刻として Date にするのでローカル時刻で読む（夏時間のある地域では、夏時間の切り替わりの時刻がずれうる。日本は該当しない）。Oracle の TIMESTAMP のミリ秒より下の桁は落ちる。
  - bit は 0 / 1、バイナリは `0x…` の 16 進（64 バイトまで）。Oracle の BLOB は中身を取らず「（BLOB n バイト）」と出す。
  - node-oracledb の JavaScript は extension.js にまとめ、Thick モード用のバイナリ（`.node`）は `dist/oracledb/` に置いて `initOracleClient` の `binaryDir` で指す。vsix には win32-x64 のものだけを入れる。

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
   - 確認用 SQL の結果は済み（§13）。接続確認は待たずに進める（D-21）。残り：DATE の時刻の使用（O-01）、文字列の日付の書式（O-10）
3. ~~O-04（spreadsheet-grid の外部フィルタモード）を確認する。~~ 済み（§11）。対応方針は O-08
4. ~~モノレポの雛形を作る。~~ 済み（仮称 `@sql-editor-tool/*`、D-13）。O-05（名前）は未確定のまま
5. ~~core から実装する：フィルタ記述子 → WHERE 句（SQL Server / Oracle の両方言）を、単体テスト付きで作る。~~ 済み（`packages/core`、SELECT 文とリテラル版を含む）
   - ~~セットフィルタの候補値の SQL（`SELECT DISTINCT` ＋件数上限。ほかの列の条件で絞る）~~ 済み（`filterOptions.ts`、§6）
   - ~~段階2のベースSQL の包み込み~~ 済み（`baseSql.ts`、§5 段階2、D-17）
   - ~~spreadsheet-grid への機能追加（D-12）は datasheet-grid リポジトリで進める~~ 済み（v0.41.0、§11.5）
6. ドライバのアダプタ、拡張本体、Webview の順に進める。Webview は spreadsheet-grid 0.41.0 以上を使う（D-14）。
   - ~~拡張本体と Webview の土台~~ 済み（デモ接続で、接続の追加 → ツリー → テーブルを開く → フィルタ → SQL プレビュー → 実行 → 取得・中止・上限、まで動く。§12）
   - 残り（段階1）：~~列の意味型の上書き（日付など）とその候補の提案、キーの上書き~~（済み、D-36・D-37）、段階2の画面（ベースSQL を開く、`checkBaseColumns`。レポート（§16）でほぼ代わりになっている）
   - ~~ドライバ（driver-mssql / driver-oracle）は、接続確認を待たずに作る（D-21）~~ 済み（2026-09-26）。Mac では実 DB に繋げないので、偽の接続での単体テストと、存在しない接続先へのエラーの確認まで
7. 会社 PC で vsix を入れ、ドライバで実際の DB に繋いで確かめる（§14）。SQL Server は済み（§14.1）。残りは Oracle（O-02）
8. ~~取得した行の絞り込みを画面ですぐに行う形に変える（D-25）~~ 済み（2026-09-26）。開発用ページで、5,000 行の上限で打ち切ったときの案内と取り直し、画面での絞り込み（5,000 行 → 118 行、約 70ms）、SQL プレビューの WHERE を確かめた。「DB で絞り込んだ条件を外したときの案内」は、デモ接続が DB 側で絞り込まないので画面では再現できず、判定の関数（`webview/src/widened.ts`）の単体テストで確かめた
9. 段階2（SQL＋フォーム、D-26・D-27）：設計は §16（D-28、D-29、D-31〜D-35）。§16 の 1〜4 は済み（2026-09-26）。残りは O-14 と、会社 PC での確認（§14.3、O-15）
10. ~~段階1の残り：列の意味型の上書き（日付など）とその候補の提案、キーの上書き~~ 済み（2026-09-26、D-36・D-37）。開発用ページ（`dev/index.html`）で、案内 →「日付として扱う」→ 列が `YYYY-MM-DD` で出て日付の絞り込みになる、「⚙ 列」の表、「使わない」、主キーのないビューでのキーの指定（`ORDER BY` に使う）を確かめた。Docker の Oracle でも、案内から取り直しまで確かめた
11. ~~サイドバーのテーブル検索（D-30）~~ 済み（2026-09-26）。開発用ページ（`dev/search.html`）と、Mac の VS Code の拡張開発ホスト（デモ接続）で、接続 → 検索 → Enter でデータビューが開くまでを確かめた
12. Oracle のドライバを Docker の Oracle で確かめた（2026-09-26、§14.4）。見つかった不具合（中止の後の ORA-01013、BLOB の大きさ）を直し、レポートの文字列のバインドを CHAR にした（D-38）。社内の 19c での確認（§14 の 4）は残る
13. .sql の入力補完（D-39）を作った（2026-09-26）。単体テスト（文脈の判定、別名の解決、候補、一覧の記憶）まで。VS Code の中での動きは、この環境に VS Code を入れられないため未確認。会社 PC か Mac の拡張開発ホストで確かめる（§14.3 の 9）

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

- 確認：`pnpm lint`、`pnpm typecheck`、`pnpm test`（core・host・ドライバの単体テスト。ドライバは偽の接続で確かめる）。
- **開発用ページ**（ブラウザで画面を確かめる）：`pnpm --filter @sql-editor-tool/webview dev:build` のあと、`packages/webview/dev/index.html`（データビュー）か `dev/search.html`（テーブル検索。偽の接続の状態を使う）、`dev/report.html`（レポート。デモ接続を使う）をブラウザで開く。ホスト側の制御とデモ接続を同じページの中で動かす。クエリで切り替えられる（`?table=CUSTOMERS&dialect=oracle&maxRows=5000`）。
- **拡張のビルド**：`pnpm --filter sql-editor-tool build`（`packages/extension/dist/` に拡張本体と Webview を出力）。VS Code で `packages/extension` を拡張開発ホストとして開けば試せる。
- **Mac の VS Code で拡張を動かして確かめる**（自動操作。2026-09-26 に使った手順）：
  - `ELECTRON_RUN_AS_NODE` などの環境変数を外して（Claude Code が VS Code の中で動いていると付いている）、`Code --extensionDevelopmentPath=<packages/extension> --user-data-dir=<短いパス> --extensions-dir=<短いパス> --remote-debugging-port=<ポート>` で起動する。`--user-data-dir` のパスが長いと、プロセス間通信のソケットのパスが 103 文字を超えて起動できない。
  - playwright-core の `chromium.connectOverCDP` でつなぎ、ワークベンチの画面を操作する。Webview の中の要素は Playwright から取れないので、マウスの座標とキーボードで操作し、スクリーンショットで確かめる。
  - 普段使いの VS Code とは別の設定フォルダで動くので、影響はない。終わったら、起動したプロセス（`--user-data-dir` で見分ける）だけを止める。
- **実際の SQL Server で確かめる**（クラウドの Claude Code の環境。2026-09-26 に使った手順）：`dockerd` を起動し、`mcr.microsoft.com/mssql/server:2022-latest` を照合順序 `Japanese_CI_AS` で動かす。架空のテーブル（受注・得意先など）を作り、ドライバ（`MssqlSession`）や `ReportController` を一時的なテストファイルからつないで確かめる（一時ファイルとパスワードはコミットしない）。社内は 2012 SP2 なので、版による違いは会社 PC で確かめる。
- **実際の Oracle で確かめる**（同じく 2026-09-26 に使った手順）：Docker Hub の `gvenzl/oracle-free:23-slim-faststart` を `ORACLE_PASSWORD`・`APP_USER`・`APP_USER_PASSWORD` を付けて動かし、`docker exec -i -e NLS_LANG=AMERICAN_AMERICA.AL32UTF8 oracle sqlplus -s <APP_USER>/<パスワード>@//localhost/FREEPDB1` で架空のテーブルを作る（日本語の表名・列名も使える）。サービス名は `FREEPDB1`。`OracleSession.open(..., { mode: "thin" })` を一時的なテストファイルからつなぐ。Oracle の公式のレジストリ（container-registry.oracle.com）はこの環境のネットワークの設定で使えない。社内は 19c・JA16SJIS なので、版と文字コードによる違いは会社 PC で確かめる。
- **vsix**：`pnpm --filter sql-editor-tool package:vsix`（`releases/` に出力。コミットしない）。会社 PC の VS Code（1.101 以降、D-22）に入れれば、デモ接続と実際の DB で動きを確かめられる。
- デモ接続は架空のデータ（受注・得意先・品目と、ビュー 1 つ）で、社内のテーブルとは関係ない。SQL は作るが、条件で行を絞り込まない（並べ替えと件数の上限だけ効く）。画面にもその旨を出している。
- Webview の注意点（実装して分かったこと）：
  - グリッドの `height="100%"` は内側のスクロール領域に当たる。外枠（`.ssg-root`）を縦の flex にし、`.ssg-shell` を伸ばさないと全行が描画される（仮想スクロールが効かない）。`packages/webview/src/styles.css` で対応済み。
  - 列メニューのボタンは、ヘッダにマウスを乗せたときだけ操作できる（自動操作で確かめるときは hover が要る）。
  - 行の高さは `density="compact"`。文字列の列は `textSet`、数値は `numberSet`、日付型と意味型が日付の列は `dateSet`。主キーの列は見出しに 🔑 を付ける。
- 設定：`sqlEditorTool.maxRows`（既定 10 万、D-11）、`sqlEditorTool.reports.folder`（レポートのフォルダ。空なら初めてレポートを作るときに選ぶ。D-29）、`sqlEditorTool.oracle.clientMode`（`thin` / `thick`、既定 `thin`。変えたらウィンドウの再読み込みが要る。D-21）、`sqlEditorTool.oracle.clientLibDir`（Thick のときの Oracle Client のフォルダ。空なら PATH から探す）、`sqlEditorTool.mssql.tlsMinVersion`（ログインの TLS の最低の版。既定は空＝TLS 1.2 以上。O-11）。設定名とコマンド名の接頭辞 `sqlEditorTool` は仮称（D-13）。名前が決まったら置き換える。

## 13. 会社 PC での確認結果（2026-09-25）

`verify/sql/` の SQL を会社 PC の A5:SQL Mk-2 で実行した結果（ユーザーが Excel で持ち帰ったもの）。ここには集計値だけを記録し、スキーマ名・テーブル名・列名は書かない。Node.js のスクリプト（`mssql-run.mjs` / `oracle-run.mjs`）での接続は、まだ確かめていない。

### 13.1 SQL Server

- バージョン：11.0.5058（2012 SP2）、Standard Edition（64-bit）。照合順序はサーバー・DB とも `Japanese_CI_AS`。
  - `CI`：大文字小文字を区別しない。`KS` / `WS` がないので、ひらがなとカタカナ、全角と半角も区別しない。`manualFiltering` ではグリッドが判定しないので、この DB の比較がそのまま結果になる。
- 型の分布（対象スキーマの全列）：nvarchar 39,500、numeric 10,613、varchar 665、datetime 320、date 263、int 252、char 169、smallint 162、decimal 92、その他は少数。
  - 文字列はほぼ nvarchar。`mssql` の既定（NVARCHAR で送る）でほとんどの列は困らない。§6 の「実際の型でバインドする」は varchar / char の列のために残す。
- decimal / numeric の精度（10,705 列）：15 桁ちょうどが 7,483 列（大半が (15,4)）、16 桁以上が 377 列（(19,0) 91、(33,23) 56、(21,6) 50 など、最大 38 桁）。
  - 15 桁までは JavaScript の数値で正しく表せる。16 桁以上の列は文字列で取得する必要がある（§6 の「数値の精度」が実際に要る）。
- 日付らしい列（型か列名で抽出、4,778 列）：nvarchar(8) 1,816、nvarchar(14) 1,009、datetime 320、nvarchar(17) 292、date 263、numeric 230、nvarchar(10) 199、ほかは少数。
  - nvarchar(8) は列名の末尾が `_DT` / `_DATE` / `_YMD` などで、`yyyymmdd` の運用と合う。意味型の候補の提案（§5 段階1）は、この形を主に拾えばよい。
  - nvarchar(14) は更新日時らしい列、nvarchar(17) は `_TIME` で終わる列が多い。numeric には `_DT` で終わる列が 47 ある。書式は O-10 で確かめる。
- 主キーの列数ごとのテーブル数：1 列 39、2 列 61、3 列 112、4 列 90、5 列 79、6 列 49、7 列 23、8 列 10、9 列 7、10 列 1。主キーのないテーブル 305（名前から見て、半数以上がバックアップ・作業用・月別の控え）。外部キー 0。

### 13.2 Oracle

- バージョン：19.19.0.0.0、Standard Edition 2。文字コード `JA16SJIS`、各国語文字コード `AL16UTF16`、`NLS_LENGTH_SEMANTICS = BYTE`。
- 型の分布（対象スキーマの全列）：VARCHAR2 6,447、NUMBER 2,013、DATE 96、CHAR 12、NVARCHAR2 8、BLOB 6。
  - CHAR は 12 列だけなので、`RPAD` の問題（O-09 (3)）の影響は小さい。BLOB は表示の対象外にする（中身は取らず「（BLOB n バイト）」と出す。§7）。
- NUMBER の精度（2,013 列）：精度の指定がない列が 669（うち 29 は位取り 0）。指定がある列は最大 13 桁。
  - 精度の指定がない NUMBER は 38 桁まで入りうる。16 桁以上の値が実際にあるかは列次第なので、ドライバでは精度の指定がない NUMBER と 16 桁以上の NUMBER を文字列で取得する（D-23）。
- 日付らしい列（型か列名で抽出、360 列）：VARCHAR2(10) 115、VARCHAR2(20) 105、DATE 96、VARCHAR2(50) 17、VARCHAR2(22) 11、NUMBER 10、ほかは少数。長さ 8 の文字列はない。
  - SQL Server と違い、Oracle では `yyyymmdd` の運用は見当たらない。VARCHAR2(10) は `yyyy/mm/dd`、VARCHAR2(20) は日時の文字列の可能性がある（O-10）。
- 主キーの列数ごとのテーブル数：1 列 83、2 列 120、3 列 86、4 列 47、5 列 19、6 列 29、7 列 8、8 列 3、9 列 2、11 列 2、15 列 1、16 列 2。主キーのないテーブル 42。外部キー 7。

### 13.3 分かったことと影響

- 段階1の残り（意味型の上書き、キーの上書き、段階2の画面）は、この結果で進められる。
  - キーの上書き：主キーのないテーブルが多いので必要。キーがないときの既定の ORDER BY は付けない（取得の順は DB 任せ）で進める。
  - 意味型：SQL Server の `yyyymmdd` はいまの core（`SemanticType = { kind: "date"; format: "yyyymmdd" }`）で扱える。ほかの書式は O-10 の結果を見て `format` を増やす。型を `format` 付きにしてあるので、増やしやすい。
- ドライバ（driver-mssql / driver-oracle）は、接続確認を待たずに作る（D-21）。数値の精度は上のとおり、SQL Server は 16 桁以上の decimal / numeric、Oracle は精度の指定がない NUMBER を文字列で取得する前提で設計する。

## 14. 会社 PC での確認手順（ドライバ、2026-09-26）

`releases/sql-editor-tool-0.1.0.vsix` を会社 PC の VS Code に入れて確かめる。持ち帰るのは、成否・件数・所要時間・エラーの番号とメッセージだけにし、ホスト名・IP・DB 名・スキーマ名・テーブル名・業務データは伏せる。

1. VS Code の「ヘルプ → バージョン情報」で、VS Code と Node.js の版を控える（D-22）。
2. SQL Server：接続を追加 → ツリーでスキーマ → テーブルまで開けるか。
   - TLS のエラー（`ssl`、`tls`、`handshake` などを含む）なら、設定 `sqlEditorTool.mssql.tlsMinVersion` を `TLSv1` にして、接続を「切断」してから開き直す（O-11）。
3. SQL Server：テーブルを開いて実行する。
   - 日本語が文字化けしないか。
   - 日付の表示（date、datetime、`yyyymmdd` の nvarchar(8)）。
   - 16 桁以上の numeric / decimal の列の値が、A5:SQL Mk-2 で見た値と一致するか（D-23）。
   - 列見出しのフィルタ：文字列の「含む」、値の選択（候補が出るまでの時間）、数値の範囲、datetime 列の日付。SQL をコピーして A5 で実行した件数と一致するか。
   - 大きいテーブルで実行 → 途中で「中止」→ すぐ止まるか。続けてもう一度実行できるか。
4. Oracle：接続を追加（Thin）→ ツリー → テーブルを開いて実行。
   - 繋がらなければ、エラーの番号（`NJS-…` / `ORA-…`）を控え、設定 `sqlEditorTool.oracle.clientMode` を `thick`（Oracle Client が PATH にないなら `sqlEditorTool.oracle.clientLibDir` も）にして、ウィンドウを再読み込みしてから試す（O-02、D-21）。
   - 精度の指定がない NUMBER の値、DATE の表示（時刻）、CHAR 列の「等しい」条件、NVARCHAR2 の日本語。
   - 「中止」がすぐ効くか。

### 14.1 結果：SQL Server（2026-09-26）

GitHub のプレリリース `v0.1.0` の vsix を会社 PC に入れ、設定は既定のまま確かめた。

- 接続：接続を追加 → ツリーでスキーマ → テーブルの一覧まで表示できた。TLS の設定の変更は不要（O-11 解決）。
- 表示：日本語の文字化けなし。日付（date、datetime、`yyyymmdd` の文字列）も正しい。
- 16 桁以上の numeric / decimal：A5:SQL Mk-2 の値とおおむね一致（ユーザーの所感は「おそらく問題なし」。列を決めて突き合わせてはいない）。
- フィルタ：文字列の「含む」、値の選択、数値の範囲、datetime 列の日付。コピーした SQL を A5 で実行した件数と一致した。
- 中止：大きいテーブルで途中で止まり、続けて実行もできた。

Oracle はまだ確かめていない（O-02）。

### 14.2 結果：画面での即時の絞り込み（0.2.0、2026-09-26）

GitHub のプレリリース `v0.2.0` の vsix を会社 PC に入れ、SQL Server で確かめた。

- 列見出しの絞り込みが、取得した行にすぐ効く。
- 行数の多いテーブルで、上限で打ち切ったときの案内が出る。「今の絞り込みで DB から取り直す」で、条件に合う行だけが取れる。

### 14.3 確認手順：レポート・列の設定・入力補完（0.4.0〜0.7.0、2026-09-26）

0.7.0 の vsix を入れて、SQL Server の接続で確かめる。持ち帰るものは §14 と同じ（業務 SQL・業務データは伏せる）。

1. サイドバーの「レポート」→「新しいレポート」でフォルダを選び、レポートを作る。業務の SQL を 1 本貼り、`:名前` の入力欄ができるか。
2. 入力欄の種類の推定（D-35、O-15）：種類を設定していない入力欄が、日付・数値・yyyymmdd の日付・文字列のどれになったか。「⚙ 入力欄」で「（推定）」と出るか。期待と違った入力欄は、SQL の形（`列 >= :名前`、`(:名前 IS NULL OR 列 = :名前)` など。列名は伏せる）と、列の型を控える。
3. 相対の日付（D-32・D-33）：日付の入力欄の既定値に `月初-1か月` などを書いて保存し、レポートを開き直すと計算した日付が入るか。
4. 選択肢（D-34）：種類を「選択肢」にし、候補の SQL（例：コードと名前を返す SELECT）を書いて保存。候補が出るまでの時間、打って絞れるか、日本語入力で絞れるか。
5. 実行して、A5:SQL Mk-2 で同じ値で実行した件数と一致するか。「今の絞り込みで DB から取り直す」も使えるか。
6. Oracle の接続でも 1〜5（推定はしないので、2 は「すべて文字列」になれば正しい）。CHAR 列と比べる入力欄があれば、A5 と件数が合うか（D-38）。
7. 列の設定（D-36・D-37）：yyyymmdd の日付の列があるテーブルを開き、案内が出るか・候補が正しいか（日付でない列が混ざっていないか）。「日付として扱う」の後、列見出しの日付の絞り込み（期間）の件数が A5 と合うか。主キーのないテーブルで「⚙ 列」からキーを指定できるか。
8. Oracle で、取得中に「中止」→ すぐにもう一度「実行」して、エラーにならないか（§14.4 で直した不具合）。
9. 入力補完（D-39、0.7.0）：
   - レポートでない .sql を開き、右下のステータスバーの「接続を選ぶ」で接続を選ぶ（ファイルを閉じて開き直しても残るか）。
   - `SELECT テーブル名.` と打つと、そのテーブルの列が出るか（型の表示、主キーの 🔑）。最初の 1 回は接続と列の取得で少し待つ。
   - `FROM 受注 j` と書いた文で `j.` と打つと、受注の列が出るか。JOIN の別名でも。
   - `FROM ` の後で打ち始めると、テーブル・ビューの名前が出るか。`dbo.` の後はそのスキーマのテーブルか。
   - 文字列（`'…'`）やコメントの中で `.` を打っても出ないか。
   - レポートの .sql では、先頭のコメントの接続が使われるか。ステータスバーで選び直すと、先頭のコメントが書き換わるか。
   - 「最新の情報に更新」の後に、DB で足した列が出るか。
   - 気になる点：候補の出るまでの時間、公式の SQL Server の拡張などほかの補完と重なって見づらくないか。

### 14.4 結果：Docker の Oracle でのドライバの確認（2026-09-26）

会社 PC の前に、クラウドの環境の Docker で Oracle 23ai Free（AL32UTF8）を動かし、`driver-oracle`（Thin モード）を架空のテーブルで確かめた（§12 の手順）。

- 動いたもの：接続（約 0.1 秒）、スキーマ・テーブル・ビューの一覧、列の型と複合主キー、日本語の表名・列名（`"..."` で囲む）、NVARCHAR2 の日本語。精度の指定がない NUMBER の 23 桁の値が文字列で全桁そのまま（`-.25` は `-0.25` にそろう）、NUMBER(15,4) は数値、DATE は時刻付き、TIMESTAMP はミリ秒まで。
- 絞り込み（WHERE 生成）：CHAR(6) の「等しい」（`RPAD`）、CHAR の後方一致（`RTRIM`）、LIKE の `%` `_` のエスケープ、空欄（`IS NULL`）、数値の範囲、23 桁の値の「等しい」、DATE の日単位の範囲（`TO_DATE`）、「これ以外」と NULL、候補値（DATE は日ごと、空欄が先頭）。どれも期待どおりの件数。
- レポート：`:名前` のバインド、日付の種類（`TO_DATE`）、画面の絞り込みで包んで取り直す（`FETCH FIRST`）、選択肢の候補の SQL。
- 列の設定（D-36・D-37）：`VARCHAR2(8)` の `出荷YMD` が案内に出て、日付として扱うと `WHERE "出荷YMD" >= '20260916'` で取り直せた。
- 中止：取得中に止めると 3ms ほどで止まる。
- 見つかって直したもの：
  1. 中止の後、次に実行した文が `ORA-01013`（中止の要求）で失敗していた。`break()` の知らせが接続に残り、`close({ drop: true })` でも接続がプールに戻っていた（プールの接続数が変わらない）。中止の後に `ping` で知らせを受け切ってから返すようにした。
  2. BLOB が「（BLOB undefined バイト）」と出ていた。ロケーターを解放してから長さを読んでいたため。
  3. レポートで CHAR 列と比べると一致しなかった（NVARCHAR でバインドしていたため）。VARCHAR2 の主キーの索引も効いていなかった（実行計画が全件を読む形）。CHAR でバインドするようにした（D-38）。
- 確かめていないもの：19c・JA16SJIS での動き、社内のパスワード方式・ネットワークの暗号化（O-02）、Thick モード。

## 15. Hayami から取り込むもの（D-27、2026-09-26 に Hayami の docs/handover.md とコードを調べた要約）

Hayami（`ishibashi0112/hayami`）は SQL Server 向けのレポートツール（SSRS 2012 代替）。参照用の SQL を 1 本登録すると、パラメータの入力フォーム＋グリッド＋Excel 出力のページができる。Phase 1（M0〜M8）は 2026-07-20 に完了、マルチ DB 化（Phase 1.5）は未着手。以下の D 番号は Hayami のもの。

- **パラメータの書き方**：`@名前` だけ（D-3）。全 DB で `@名前` に統一し、アダプタで `:name` などに変換する方針（D-20、未実装）。抽出は、文字列・コメント・`[...]`・`"..."` を除いた上で `(?<!@)@([\p{L}_][\p{L}\p{Nd}_$#]*)`（日本語名も可、`@@VERSION` は除く）。
- **型の推定**：列は `sp_describe_first_result_set`、パラメータは `sp_describe_undeclared_parameters`。同じパラメータを 2 回使うとエラー 11508 になるので、全パラメータを `nvarchar(4000)` で宣言して取り直す。推定できなければ `nvarchar(4000)` とし、警告を出す。実際の業務 SQL 11 本では、パラメータの型の推定が 5 本で失敗した。成功しても日付のつもりが `nvarchar(4000)` になることがあり、手で直す前提。
- **入力欄の種類**：保存せず、型から毎回決める。選択肢 SQL（1 列目＝値、2 列目＝表示名）があれば選択、bit はチェックボックス、数値型は数値、日付型は日付、それ以外は文字列。利用者が直せるのは型・表示名・選択肢 SQL（必須と既定値はデータにあるが画面では未対応）。
- **空欄**：既定値を使う。それもなく必須ならエラー、必須でなければ NULL を渡す。「空なら条件ごと外す」機能はない（SQL 側で `(@p IS NULL OR col = @p)` と書く）。
- **保存の形**：1 レポート＝SQL＋パラメータの定義（名前、推定した型、使う型、表示名、必須、既定値、選択肢 SQL）＋列の定義（表示名、表示するか、Excel の書式、幅、寄せ）。パラメータと列は JSON で持つので、書き出し・読み込みにそのまま使える。SQL を直したときは、名前で対応付けて、利用者が直した設定を引き継ぐ（マージ規則）。
- **安全**：実行できるのは保存したレポートの SQL だけ（任意の SQL を実行する口を持たない）。値は必ずバインド変数。取得の上限（5 万行）と時間の上限（60 秒）を既定で有効にしている。
- **表示と Excel**：Excel の書式文字列 1 つで、画面の表示と Excel 出力の両方をまかなう（整数 `#,##0`、日付 `yyyy/mm/dd` など）。5 万行 × 118 列の Excel 出力に約 40 秒かかる（exceljs）。
- **Windows での検証で分かったこと**：社内 DB は日付を `yyyymmdd` の文字列で持つので、型を date に直しても日付の入力欄がそのままでは使えなかった（書式つきの日付の入力欄が要る）。値を `'1'` のように引用符つきで入れる誤りがあった。日本語入力は非制御の入力欄（`ImeSafeText`）が必要。
- **このツールに取り込むときの注意**：Oracle にはパラメータの型を推定する仕組みがない（O-13）。書き方（O-12）、字句解析（`q'[...]'` など）、推定できないときの既定の型は、方言ごとに決める。

## 16. レポート（SQL＋フォーム）の設計（D-26〜D-29、2026-09-26）

### ファイル

- レポートは `.sql` ファイル。SQL の中の `:名前` がフォームの入力欄になる（D-28）。
- 先頭のブロックコメントに設定を JSON で持つ（画面で直すと拡張が書き込む。手で書く必要はない）。コメントがない `.sql` でも、`:名前` があればレポートとして開ける（設定は既定値）。

```sql
/* @report
{
  "connection": "基幹（SQL Server）",
  "params": {
    "開始日": { "label": "受注日（から）", "type": "ymd", "required": true, "default": "月初" },
    "得意先": { "type": "text", "required": false }
  }
}
*/
SELECT * FROM 受注
WHERE 受注日 >= :開始日
  AND (:得意先 IS NULL OR 得意先コード = :得意先)
```

（例の表名・列名は架空）

- 接続は名前で結び付ける（接続の ID は PC ごとに違うため）。見つからなければ、開いたときに選んでもらう。
- JSON の文字列に `*/` が入るときは `*\/` と書いて、コメントが途中で閉じないようにする。

### 保存先と呼び出し方（「どこに保存したか分からなくならない」ように）

- **レポートのフォルダ**（設定 `sqlEditorTool.reports.folder`）に 1 か所にまとめる。初めて「新しいレポート」を作るときにフォルダを選んでもらう（候補はドキュメント）。サブフォルダで分類できる。
- **サイドバーの「レポート」ビュー**（「接続」の下）：フォルダの中の `.sql` を一覧（サブフォルダはフォルダとして）。クリックでレポートの画面を開く。名前で絞り込める（TreeView の検索）。右クリックで「SQL を編集」「名前を変更」「削除」「エクスプローラーで表示」。上部に「新しいレポート」「更新」「フォルダを変更」。
- **コマンド「レポートを開く」**（コマンドパレット）：一覧から名前で検索して開く。最近使ったものを上に出す。
- **エディタの「レポートとして開く」ボタン**（`.sql` を開いているときの右上の ▶）：フォルダの外の `.sql` も、書いている途中の SQL も開ける。

### レポートの画面

```
受注一覧　　接続：基幹（SQL Server）▼　　　　　　　　　　　　[SQL を編集]
受注日（から）[2026/09/01]　得意先 [C00027　]　[▶ 実行] [■ 中止]　1,234 行（0.8 秒）
┌ 結果のグリッド（列見出しで、すぐ絞り込み・並べ替え。D-25）─────────────┐
```

- 入力欄の横の ⚙ で、種類・表示名・必須・既定値を直す。種類は、文字列（既定）・数値・日付（DATE 型の列と比べる）・yyyymmdd の日付（文字列の列と比べる。入力は日付の選択）・選択肢（候補を SQL で取る）。
- 入力欄の種類は、SQL Server なら `sp_describe_undeclared_parameters` で候補を出す（Hayami と同じ。推定に失敗したら文字列）。Oracle は推定の仕組みがないので文字列から始め、利用者が直す（O-13）。
- 空欄：必須なら実行できない。必須でなければ NULL を渡す（SQL 側で `(:名前 IS NULL OR 列 = :名前)` と書く）。
- 結果は、テーブルを開いたときと同じく画面ですぐ絞り込める。上限で打ち切ったら、レポートの SQL を派生テーブルで包み、画面の絞り込みを WHERE にして取り直す（`baseSql.ts`。D-17 の「バインド変数を含まない」は、`:名前` については外す）。
- 日本語入力：入力欄は非制御にする（Hayami の `ImeSafeText` と同じ。§7）。SQL はエディタで書くので問題ない。

### 作る順（1〜4 は 2026-09-26 に済み）

1. core：`:名前` の抽出と DB ごとの形への変換、設定のコメントの読み書き、ベースSQL の包み込みで `:名前` を受け付ける。
2. host：結果の列の型をドライバから受け取る（`onColumns` に型を足す。レポートの結果は `describeTable` で型が分からないため）。レポートの画面の制御（`ReportController`）。
3. 拡張：「レポート」ビュー、コマンド、エディタのボタン、レポートの画面。
4. SQL Server の入力欄の種類の推定。選択肢（候補の SQL）。既定値に「今日」「月初」など日付の相対の指定（Hayami でも未決）。

### できたもの（2026-09-26）

- サイドバーの「レポート」ビュー（レポートのフォルダの中の `.sql` をフォルダの形で並べる。上部に「新しいレポート」「レポートを開く（名前で検索、最近使ったものが上）」「最新の情報に更新」「フォルダを変更」、項目の右クリックで「SQL を編集」「名前を変更」「削除（ごみ箱へ）」「エクスプローラーで表示」）。
- `.sql` のエディタの右上とエクスプローラーの右クリックに「レポートとして開く」。
- 「新しいレポート」は名前を聞いてテンプレートの `.sql` を作り、エディタとレポートの画面を並べて開く。「受注/受注一覧」のように書くとサブフォルダに作る。
- レポートの画面：接続名は先頭のコメントで結び付け、「接続：… ▾」で選び直せる（コメントに書く）。フォームの値はレポートごとに覚えておき、次に開いたときに入れる。SQL を書き換えると（保存していなくても）入力欄を作り直す。
- 確かめたこと：開発用ページ（`dev/report.html`）と、Mac の VS Code の拡張開発ホスト（デモ接続）で、「レポート」ビューから開く → 値を入れて実行 → 必須の空欄で止まる → 「⚙ 入力欄」で表示名を保存（ファイルの先頭のコメントに書かれる）→「SQL を編集」で横に開く、まで。

### できたもの：§16 の 4（2026-09-26、0.5.0）

- **相対の日付の既定値**（D-32・D-33）：「⚙ 入力欄」の既定値に `月初-1か月` などを書ける。日付の種類のときは、書いた横に今日ならいつになるか（「→ 2026-08-01（今日なら）」）を出す。日付でも相対の日付でもない既定値は、保存のときにエラーにする。
- **選択肢**（D-34）：種類「選択肢（候補を SQL で取る）」を選ぶと、その下に候補の SQL の欄が出る。フォームでは「打って絞れるリスト」になる（`webview/src/report/OptionsField.tsx`）。候補の取得中は「候補を読み込み中…」、失敗したら入力欄の下にエラー、1 万件で打ち切ったら一覧の下にその旨を出す。
  ```sql
  /* @report
  {
    "params": {
      "得意先": {
        "type": "select",
        "required": false,
        "options": "SELECT 得意先コード, 得意先名 FROM 得意先 ORDER BY 得意先コード"
      }
    }
  }
  */
  ```
  （例の表名・列名は架空）
- **入力欄の種類の推定**（D-35）：`driver-mssql` の `guessParamTypes`（`DbSession` の省略できるメソッド。Oracle のドライバは持たない）。まとめ方は core の `reportParamProbe` / `guessReportParamTypes`。デモ接続は SQL を解釈しないので、名前だけで決める（画面を確かめるためのもの）。
- 確かめたこと：単体テスト（core・host・driver-mssql）。SQL Server 2022（Docker、照合順序 `Japanese_CI_AS`、架空のテーブル）で、推定の結果（`>=` の yyyymmdd の列 → yyyymmdd の日付、`IS NULL` を除いた推定、`COALESCE` の出現を宣言に回した再推定、テーブル名の誤りでは推定しない）と、`ReportController` を通しての推定・候補の取得・実行。開発用ページ（`dev/report.html`）で、フォーム・打って絞れるリスト（打つ、↑↓ と Enter、クリック、Escape、空にすると NULL、フォーカスだけでは開かず Enter で実行）・「⚙ 入力欄」（（推定）の表示、候補の SQL の欄、既定値の確かめ、保存）。VS Code の拡張開発ホストでは確かめていない（この環境に VS Code がないため）。
