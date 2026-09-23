-- DATE型の列で、時刻部分が実際に使われているかを確認する（O-01でDATE型だった場合）
-- <TABLE> と <COLUMN> を書き換えてから、このファイルを個別に指定して実行してください。
-- 大きなテーブルでも負荷をかけないよう、先頭10万行だけを対象にしています。
SELECT COUNT(*) AS sampled,
       SUM(CASE WHEN <COLUMN> <> TRUNC(<COLUMN>) THEN 1 ELSE 0 END) AS with_time
FROM (SELECT <COLUMN> FROM <TABLE> WHERE ROWNUM <= 100000);
