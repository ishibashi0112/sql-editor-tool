-- 論理名（D-40、O-16）：A5:SQL Mk-2 の論理名がどこから来ているかを確かめる。
-- COMMENT ON TABLE / COLUMN があるものの件数と、区切り（: タブ 改行）を含む件数。値そのもの（業務の名前）は出さない
SELECT 'table_or_view' AS target,
       COUNT(*) AS total,
       COUNT(comments) AS with_comment,
       SUM(CASE WHEN INSTR(comments, ':') > 0 THEN 1 ELSE 0 END) AS with_colon,
       SUM(CASE WHEN INSTR(comments, CHR(9)) > 0 THEN 1 ELSE 0 END) AS with_tab,
       SUM(CASE WHEN INSTR(comments, CHR(10)) > 0 THEN 1 ELSE 0 END) AS with_newline,
       SUM(CASE WHEN INSTR(comments, '：') > 0 THEN 1 ELSE 0 END) AS with_fullwidth_colon,
       MAX(LENGTH(comments)) AS max_len
FROM all_tab_comments
WHERE owner = :owner
UNION ALL
SELECT 'column',
       COUNT(*),
       COUNT(comments),
       SUM(CASE WHEN INSTR(comments, ':') > 0 THEN 1 ELSE 0 END),
       SUM(CASE WHEN INSTR(comments, CHR(9)) > 0 THEN 1 ELSE 0 END),
       SUM(CASE WHEN INSTR(comments, CHR(10)) > 0 THEN 1 ELSE 0 END),
       SUM(CASE WHEN INSTR(comments, '：') > 0 THEN 1 ELSE 0 END),
       MAX(LENGTH(comments))
FROM all_col_comments
WHERE owner = :owner;
