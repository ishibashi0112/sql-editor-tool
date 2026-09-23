-- 日付らしい列の型・長さの集計（O-01：DATE型か yyyymmdd 文字列か）
SELECT data_type, data_length, COUNT(*) AS cnt
FROM all_tab_columns
WHERE owner = :owner
  AND (data_type = 'DATE' OR data_type LIKE 'TIMESTAMP%'
       OR column_name LIKE '%YMD%' OR column_name LIKE '%DATE%'
       OR column_name LIKE '%DT%' OR column_name LIKE '%日%')
GROUP BY data_type, data_length
ORDER BY cnt DESC;

-- 明細
SELECT table_name, column_name, data_type, data_length, nullable
FROM all_tab_columns
WHERE owner = :owner
  AND (data_type = 'DATE' OR data_type LIKE 'TIMESTAMP%'
       OR column_name LIKE '%YMD%' OR column_name LIKE '%DATE%'
       OR column_name LIKE '%DT%' OR column_name LIKE '%日%')
ORDER BY table_name, column_id;
