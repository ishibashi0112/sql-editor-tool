-- 確かめる用の架空の DB（検証）。社内のテーブルとは関係ない。
-- start.sh が、DB「検証」がなければ流す。照合順序は社内と同じ Japanese_CI_AS（コンテナの既定）
CREATE DATABASE 検証 COLLATE Japanese_CI_AS;
GO
USE 検証;
GO
-- 主キーのある表 2 つと、主キーのない表 1 つ（差分カメラのキーのない表の確認用）
CREATE TABLE dbo.ORDERS (ORDER_NO nvarchar(10) NOT NULL PRIMARY KEY, ORDER_YMD nvarchar(8), QTY int, CUST_CD nvarchar(6));
CREATE TABLE dbo.CUSTOMERS (CUST_CD nvarchar(6) NOT NULL PRIMARY KEY, CUST_NAME nvarchar(40), PREF nvarchar(10));
CREATE TABLE dbo.WORK_LOG (LOG_YMD nvarchar(8), ORDER_NO nvarchar(10), MEMO nvarchar(100));
GO
CREATE VIEW dbo.V_ORDERS AS SELECT ORDER_NO, QTY FROM dbo.ORDERS;
GO
-- 論理名（D-40）：拡張プロパティの MS_Description
EXEC sp_addextendedproperty N'MS_Description', N'受注明細', N'SCHEMA', N'dbo', N'TABLE', N'ORDERS';
EXEC sp_addextendedproperty N'MS_Description', N'受注番号', N'SCHEMA', N'dbo', N'TABLE', N'ORDERS', N'COLUMN', N'ORDER_NO';
EXEC sp_addextendedproperty N'MS_Description', N'受注日', N'SCHEMA', N'dbo', N'TABLE', N'ORDERS', N'COLUMN', N'ORDER_YMD';
EXEC sp_addextendedproperty N'MS_Description', N'数量', N'SCHEMA', N'dbo', N'TABLE', N'ORDERS', N'COLUMN', N'QTY';
EXEC sp_addextendedproperty N'MS_Description', N'得意先コード', N'SCHEMA', N'dbo', N'TABLE', N'ORDERS', N'COLUMN', N'CUST_CD';
EXEC sp_addextendedproperty N'MS_Description', N'得意先', N'SCHEMA', N'dbo', N'TABLE', N'CUSTOMERS';
EXEC sp_addextendedproperty N'MS_Description', N'得意先コード', N'SCHEMA', N'dbo', N'TABLE', N'CUSTOMERS', N'COLUMN', N'CUST_CD';
EXEC sp_addextendedproperty N'MS_Description', N'得意先名', N'SCHEMA', N'dbo', N'TABLE', N'CUSTOMERS', N'COLUMN', N'CUST_NAME';
EXEC sp_addextendedproperty N'MS_Description', N'都道府県', N'SCHEMA', N'dbo', N'TABLE', N'CUSTOMERS', N'COLUMN', N'PREF';
EXEC sp_addextendedproperty N'MS_Description', N'作業記録:主キーのない表', N'SCHEMA', N'dbo', N'TABLE', N'WORK_LOG';
EXEC sp_addextendedproperty N'MS_Description', N'記録日', N'SCHEMA', N'dbo', N'TABLE', N'WORK_LOG', N'COLUMN', N'LOG_YMD';
EXEC sp_addextendedproperty N'MS_Description', N'未完了の受注', N'SCHEMA', N'dbo', N'VIEW', N'V_ORDERS';
-- MS_Description 以外の拡張プロパティは読まない
EXEC sp_addextendedproperty N'別のプロパティ', N'使わない', N'SCHEMA', N'dbo', N'TABLE', N'ORDERS', N'COLUMN', N'QTY';
GO
INSERT INTO dbo.CUSTOMERS VALUES (N'C00001', N'山田商店', N'東京都'), (N'C00002', N'佐藤工業', N'大阪府');
INSERT INTO dbo.ORDERS VALUES (N'D001', N'20260901', 5, N'C00001'), (N'D002', N'20260902', 7, N'C00002'), (N'D003', N'20260915', 12, N'C00001'), (N'D004', N'20260820', 3, N'C00002');
INSERT INTO dbo.WORK_LOG VALUES (N'20260901', N'D001', N'登録'), (N'20260902', N'D002', N'登録');
GO
