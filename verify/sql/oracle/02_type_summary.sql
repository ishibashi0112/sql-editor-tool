-- スキーマ全体の型の分布（CHAR列の多さ、NUMBERの使われ方などを見る）
SELECT data_type, COUNT(*) AS cnt
FROM all_tab_columns
WHERE owner = :owner
GROUP BY data_type
ORDER BY cnt DESC;

-- NUMBERの精度の分布（15桁を超えるものはJavaScriptの数値で精度が落ちる。精度が空欄＝上限なし）
SELECT data_precision, data_scale, COUNT(*) AS cnt
FROM all_tab_columns
WHERE owner = :owner AND data_type = 'NUMBER'
GROUP BY data_precision, data_scale
ORDER BY cnt DESC;
