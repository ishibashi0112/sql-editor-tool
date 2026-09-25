-- 文字列（または数値）で日付を持つ列の書式を確認する（O-10）
-- 値そのものは出さず、数字を 9 に置き換えた形（例：99999999）ごとの件数だけを数える。
-- 空文字は長さ 0 の形として出る。
-- <TABLE> と <COLUMN> を書き換えてから、このファイルを個別に指定して実行してください。
-- 大きなテーブルでも負荷をかけないよう、先頭10万行だけを対象にしています。
SELECT pattern, COUNT(*) AS cnt
FROM (
  SELECT TOP (100000)
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      CAST(<COLUMN> AS nvarchar(50)),
      '0', '9'), '1', '9'), '2', '9'), '3', '9'), '4', '9'), '5', '9'), '6', '9'), '7', '9'), '8', '9') AS pattern
  FROM <TABLE>
) x
GROUP BY pattern
ORDER BY cnt DESC;
