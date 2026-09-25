# verify：会社PCでの接続・前提確認

`docs/handover.md` の未確定事項 O-01〜O-03 を確認するためのスクリプトです。会社PC（社内DBに届く環境）で実行します。

## 準備

1. Node.js をインストール済みであることを確認します。VS Code 拡張は VS Code 内蔵の Node.js で動くので、「ヘルプ > バージョン情報」に表示される Node.js のバージョンと、ここで使うバージョンの差を控えておくと、後で比較できます（スクリプトの最初にも表示されます）。
2. このフォルダで依存を入れます。

   ```
   npm install
   ```

3. `.env.example` を `.env` にコピーし、接続情報を入れます。パスワードは空欄のままにしておくと、実行時に画面に表示せずに入力できます（推奨）。

## 実行

接続確認だけ行う場合：

```
node oracle-run.mjs
node mssql-run.mjs
```

確認用SQLをまとめて実行する場合（フォルダ直下の .sql を名前順に実行します）：

```
node oracle-run.mjs sql/oracle
node mssql-run.mjs sql/mssql
```

Oracle でDATE型の列が見つかった場合は、`sql/oracle/manual/date_time_usage.sql` の `<TABLE>` と `<COLUMN>` を書き換えて、個別に実行します。

```
node oracle-run.mjs sql/oracle/manual/date_time_usage.sql
```

文字列で日付を持っていそうな列（Oracle の VARCHAR2(10) / (20)、SQL Server の nvarchar(10) / (14) / (17) や numeric の `〜_DT` など）は、`manual/string_date_format.sql` の `<TABLE>` と `<COLUMN>` を書き換えて実行し、書式を確認します（O-10）。値そのものは出さず、数字を `9` に置き換えた形（`9999/99/99` など）ごとの件数だけを出します。

```
node oracle-run.mjs sql/oracle/manual/string_date_format.sql
node mssql-run.mjs sql/mssql/manual/string_date_format.sql
```

結果は画面に先頭50行が表示され、全件が `out/` にCSV（Excelで開けるBOM付きUTF-8）で保存されます。

## 安全のための仕組み

- SELECT / WITH 以外の文は実行しません。実行前に全ファイルを検査し、1つでも該当すれば何も実行しません。
- プレースホルダ（`<TABLE>` など）が残っている場合も実行しません。
- パスワードは表示・出力しません。接続先のホスト名も画面に出しません。

## 持ち帰るときの注意

`out/` のCSVやエラーメッセージには、社内のスキーマ名・テーブル名・IPが含まれることがあります。Mac側やチャットに持ち帰るときは、判断に必要な情報（型の分布、件数、バージョンなど）だけにして、名前やIPはマスクしてください。`out/` と `.env` は `.gitignore` 済みです。

## うまくいかないとき

- **Oracle に Thin モードで接続できない**：次のような原因が考えられます。エラーメッセージを控えて持ち帰ってください。
  - DBのバージョンが Thin モードの対象外（12.1 より古い）。
  - アカウントのパスワード方式が古く、Thin モードで扱えない。
  - サーバー側でネイティブネットワーク暗号化が必須になっている。
- **SQL Server に接続できず、TLS や SSL に関するエラーが出る**：`.env` の `MSSQL_TLS_MIN_VERSION=TLSv1` を設定して再実行してください。
- **バインド変数の値がないと言われる**：`.env` の `BIND_OWNER`（Oracle、大文字）や `BIND_SCHEMA`（SQL Server）を設定してください。
