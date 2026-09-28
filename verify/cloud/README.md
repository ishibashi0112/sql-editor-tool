# verify/cloud：クラウドの環境で、拡張を画面と実際の DB で確かめる

クラウドの Claude Code の環境（Linux のコンテナ）で、Docker の SQL Server（架空の DB「検証」）と code-server（ブラウザで動く VS Code）を起こし、vsix を入れて画面を Playwright で操作するための仕組みです。会社 PC に持っていく前の確認に使います。

- 社内の DB・テーブル・データは使いません。表とデータは架空のものです（`mssql/setup.sql`・`oracle/setup.sql`）。
- パスワードは作業フォルダの `.dbpw` に作り、画面やログに出しません。コミットもしません。
- 社内は SQL Server 2012 SP2・Oracle 19c（JA16SJIS）なので、版や文字コードによる違いは会社 PC で確かめます（`docs/company-pc-checklist.md`）。

## 始め方

```sh
pnpm install
pnpm --filter sql-editor-tool package:vsix                               # releases/ に vsix を作る
bash verify/cloud/start.sh "$PWD/releases/sql-editor-tool-<版>.vsix"      # SQL Server と code-server を起こし、vsix を入れる
cd verify/cloud/pw && npm install                                        # Playwright（playwright-core）
node connect.mjs                                                         # 接続「検証DB」を追加する（最初に 1 回）
node run-sql.mjs                                                         # .sql の実行を確かめる
node diff-camera.mjs                                                     # 差分カメラを通しで確かめる
node generate-sql.mjs                                                    # SQL の生成（テーブルの右クリック → SELECT → 実行）を確かめる
```

- 初回の `start.sh` は、code-server を入れるので 2〜3 分かかります（`install-code-server.sh`）。2 回目からはすぐです。
- 環境が止まって起き直したとき（dockerd と code-server が止まります）は、`start.sh` をもう一度実行すれば戻ります。何度実行してもかまいません。
- 拡張を直したら、vsix を作り直して `start.sh <vsix>` を実行します（code-server を止めて入れ直し、起こし直します）。開いているブラウザは読み込み直してください。
- スクリーンショットやコピーした中身は、作業フォルダの `shots/` に出ます。
- 架空の表は、DB「検証」がないときに `mssql/setup.sql` で作ります。主キーが 2 列の表 `ORDER_LINES`（SQL の生成の確認用）は 0.13.0 のときに足したので、それより前に作った DB にはありません（`mssql/setup.sql` の `ORDER_LINES` の部分を `USE 検証;` の後に流すか、コンテナ `mssql` を消して `start.sh` で作り直します）。

## 作業フォルダ

既定は `/tmp/sql-editor-tool-verify` です（リポジトリの外。環境変数 `WORK` で変えられます）。

| 置くもの | 中身 |
|---|---|
| `.dbpw` | SQL Server の sa のパスワード（初回に作る） |
| `cs/` | code-server（npm から入れたもの） |
| `csud/`・`csext/` | code-server の設定と拡張。設定は `code-server/settings.json` を初回に写す |
| `ws/` | code-server で開くフォルダ。`ws/` の .sql を初回に写す（あるものは上書きしない） |
| `pwprofile/` | Playwright のブラウザのプロファイル。code-server は接続のパスワード（SecretStorage）をブラウザの側に保存するので、同じプロファイルを使い続ける |
| `shots/` | スクリーンショットなど |

ポートは SQL Server が 14330（`MSSQL_PORT`）、code-server が 18080（`CS_PORT`）です。

## 画面を操作するスクリプトを書くとき（`pw/`）

`pw/common.mjs` の部品を使います。

- `open()`：code-server を開く。`command(page, "…")`：コマンドパレットから実行する。
- `frameWith(page, selector)`：結果のパネルや差分カメラなど Webview の中の要素は、その Webview のフレームを探してから操作する。
- `sql("…")`：Docker の SQL Server で SQL を流す（画面の操作の代わりに DB を書き換える。試した後は元に戻す）。
- `collapseViews(page, [...])`：サイドバーのほかのビューを畳んで、見たいビューを広くする。
- `shot(page, name)`：スクリーンショットを撮る。

分かっている癖：

- QuickPick の複数選択は、チェックボックスをクリックしてから Enter では決まらない。行をクリックしてから「OK」を押す。
- code-server のファイルの選択（保存先など）はパスを打つ欄。打った後は Enter ではなく「OK」を押す（Enter は下の一覧の項目に当たる）。フォルダを選ぶときは末尾の `/` を付けない。
- 名前が「日」で終わる入力欄は日付の欄になり、`fill` には `2026-09-01` の形で入れる。
- code-server の設定（`csud/User/settings.json`）をファイルで書き換えても、開いている画面には効かない。画面を読み込み直す。

## Oracle で確かめるとき

Oracle の公式のレジストリはこの環境のネットワークの設定で使えないので、Docker Hub の `gvenzl/oracle-free` を使います。vsix の Thick モード用のバイナリは Windows のものだけなので、Thin モードで確かめます。接続を追加するときは、ホスト `localhost`・ポート 15210・サービス名 `FREEPDB1`・ユーザー `verify`・パスワードは `.dbpw` と同じです。

```sh
(umask 077 && printf 'ORACLE_PASSWORD=%s\nAPP_USER=verify\nAPP_USER_PASSWORD=%s\n' "$(cat /tmp/sql-editor-tool-verify/.dbpw)" "$(cat /tmp/sql-editor-tool-verify/.dbpw)" > /tmp/sql-editor-tool-verify/oracle.env)
docker run -d --name oracle --env-file /tmp/sql-editor-tool-verify/oracle.env -p 15210:1521 gvenzl/oracle-free:23-slim-faststart
rm /tmp/sql-editor-tool-verify/oracle.env
# docker logs oracle に「DATABASE IS READY TO USE」が出るまで待つ（2 分ほど）。その後、架空の表を作る（サービス名は FREEPDB1）
docker exec -i -e NLS_LANG=AMERICAN_AMERICA.AL32UTF8 oracle sqlplus -s "verify/$(cat /tmp/sql-editor-tool-verify/.dbpw)@//localhost/FREEPDB1" < verify/cloud/oracle/setup.sql
```
