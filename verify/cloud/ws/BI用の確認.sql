-- BI ツールに登録する SQL（架空の表）。SQL Server の @変数 のまま Ctrl+Enter で試す
SELECT o.ORDER_NO, o.ORDER_YMD, o.QTY, c.CUST_NAME
FROM dbo.ORDERS o
JOIN dbo.CUSTOMERS c ON c.CUST_CD = o.CUST_CD
WHERE o.ORDER_YMD >= @開始日
  AND (@得意先 IS NULL OR o.CUST_CD = @得意先)
