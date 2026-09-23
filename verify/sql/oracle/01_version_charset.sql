-- DBのバージョン
SELECT * FROM product_component_version;

-- 文字コード関連の設定
SELECT parameter, value
FROM nls_database_parameters
WHERE parameter IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET', 'NLS_LENGTH_SEMANTICS');
