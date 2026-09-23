-- DBのバージョンと照合順序
SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS product_version,
       CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128)) AS product_level,
       CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
       CAST(SERVERPROPERTY('Collation') AS nvarchar(128)) AS server_collation,
       CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) AS db_collation;
