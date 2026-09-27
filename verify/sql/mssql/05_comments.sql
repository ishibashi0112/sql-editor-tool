-- 論理名（D-40、O-16）：A5:SQL Mk-2 の論理名がどこから来ているかを確かめる。
-- 拡張プロパティの名前ごと・対象（テーブル／列）ごとの件数と、区切り（: タブ 改行）を含む件数。値そのもの（業務の名前）は出さない。
-- 半角の : と全角の ： は、Japanese_CI_AS では同じとみなされるので、BIN2 の照合順序で比べる
-- MS_Description がたくさんあれば、このツールも同じ論理名を出せる
SELECT ep.name AS property_name,
       CASE WHEN ep.minor_id = 0 THEN 'table_or_view' ELSE 'column' END AS target,
       COUNT(*) AS cnt,
       SUM(CASE WHEN CHARINDEX(N':', CONVERT(nvarchar(4000), ep.value) COLLATE Latin1_General_BIN2) > 0 THEN 1 ELSE 0 END) AS with_colon,
       SUM(CASE WHEN CHARINDEX(NCHAR(9), CONVERT(nvarchar(4000), ep.value)) > 0 THEN 1 ELSE 0 END) AS with_tab,
       SUM(CASE WHEN CHARINDEX(NCHAR(10), CONVERT(nvarchar(4000), ep.value)) > 0 THEN 1 ELSE 0 END) AS with_newline,
       SUM(CASE WHEN CHARINDEX(N'：', CONVERT(nvarchar(4000), ep.value) COLLATE Latin1_General_BIN2) > 0 THEN 1 ELSE 0 END) AS with_fullwidth_colon,
       MAX(LEN(CONVERT(nvarchar(4000), ep.value))) AS max_len
FROM sys.extended_properties ep
JOIN sys.objects o ON o.object_id = ep.major_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE ep.class = 1 AND s.name = @schema AND o.type IN ('U', 'V')
GROUP BY ep.name, CASE WHEN ep.minor_id = 0 THEN 'table_or_view' ELSE 'column' END
ORDER BY cnt DESC;

-- MS_Description がある割合（テーブル・ビューと列）
SELECT
  (SELECT COUNT(*) FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = @schema AND o.type IN ('U', 'V')) AS objects,
  (SELECT COUNT(*) FROM sys.extended_properties ep JOIN sys.objects o ON o.object_id = ep.major_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE ep.class = 1 AND ep.minor_id = 0 AND ep.name = N'MS_Description'
      AND s.name = @schema AND o.type IN ('U', 'V')) AS objects_with_description,
  (SELECT COUNT(*) FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = @schema AND o.type IN ('U', 'V')) AS columns,
  (SELECT COUNT(*) FROM sys.extended_properties ep JOIN sys.objects o ON o.object_id = ep.major_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE ep.class = 1 AND ep.minor_id > 0 AND ep.name = N'MS_Description'
      AND s.name = @schema AND o.type IN ('U', 'V')) AS columns_with_description;
