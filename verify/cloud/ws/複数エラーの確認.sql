-- ほかの整形の拡張で「:」が分かれた SQL（架空の表）。実行すると、エラーごとにファイルの行が出る（O-18）。
-- 整形（Shift+Alt+F）すると「:名前」に戻る（D-45）
WITH
  X AS (
    SELECT o.ORDER_NO FROM dbo.ORDERS o
    WHERE o.ORDER_YMD BETWEEN: 開始 AND: 終了
  ),
  Y AS (
    SELECT c.CUST_CD FROM dbo.CUSTOMERS c
    WHERE c.CUST_CD = : 得意先
  )
SELECT * FROM X, Y
