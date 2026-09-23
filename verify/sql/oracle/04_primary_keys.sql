-- 主キーの列数ごとのテーブル数（複合主キーの多さ）
SELECT key_cols, COUNT(*) AS tables
FROM (
  SELECT c.table_name, COUNT(*) AS key_cols
  FROM all_constraints c
  JOIN all_cons_columns cc
    ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
  WHERE c.owner = :owner AND c.constraint_type = 'P'
  GROUP BY c.table_name
)
GROUP BY key_cols
ORDER BY key_cols;

-- 主キーのないテーブル（キー列の手動指定が必要になるもの）
SELECT t.table_name
FROM all_tables t
WHERE t.owner = :owner
  AND NOT EXISTS (
    SELECT 1 FROM all_constraints c
    WHERE c.owner = t.owner AND c.table_name = t.table_name AND c.constraint_type = 'P'
  )
ORDER BY t.table_name;

-- 外部キーの数（念のため。0件の想定）
SELECT COUNT(*) AS fk_count
FROM all_constraints
WHERE owner = :owner AND constraint_type = 'R';
