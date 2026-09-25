-- 文字列で日付を持つ列の書式を確認する（O-10）
-- 値そのものは出さず、数字を 9 に置き換えた形（例：9999/99/99）ごとの件数だけを数える。
-- <TABLE> と <COLUMN> を書き換えてから、このファイルを個別に指定して実行してください。
-- 大きなテーブルでも負荷をかけないよう、先頭10万行だけを対象にしています。
SELECT pattern, COUNT(*) AS cnt
FROM (
  SELECT TRANSLATE(<COLUMN>, '0123456789', '9999999999') AS pattern
  FROM <TABLE>
  WHERE ROWNUM <= 100000
)
GROUP BY pattern
ORDER BY cnt DESC;
