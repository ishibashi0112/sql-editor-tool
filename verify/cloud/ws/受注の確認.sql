-- 受注の確認（架空の表）。文にカーソルを置いて Ctrl+Enter
SELECT o.ORDER_NO, o.ORDER_YMD, o.QTY, c.CUST_NAME
FROM dbo.ORDERS o
JOIN dbo.CUSTOMERS c ON c.CUST_CD = o.CUST_CD
WHERE o.QTY >= 1;

-- :名前 は結果のタブの上の入力欄になる
SELECT * FROM dbo.CUSTOMERS WHERE PREF = :都道府県;

SELECT * FROM dbo.V_ORDERS;
