// SQL Server への接続確認（mssql / tedious）と SQL ファイルの実行
// 使い方: node mssql-run.mjs [SQLファイルまたはフォルダ ...]
import 'dotenv/config';
import sql from 'mssql';
import { promptHidden, runSqlFiles } from './lib.mjs';

const env = process.env;
if (!env.MSSQL_SERVER || !env.MSSQL_USER || !env.MSSQL_DATABASE) {
  console.error('.env に MSSQL_SERVER、MSSQL_USER、MSSQL_DATABASE を設定してください');
  process.exit(1);
}
const password = env.MSSQL_PASSWORD || (await promptHidden('SQL Server パスワード: '));

const config = {
  server: env.MSSQL_SERVER,
  user: env.MSSQL_USER,
  password,
  database: env.MSSQL_DATABASE,
  // 名前付きインスタンスとポート指定は同時に使えない
  ...(env.MSSQL_INSTANCE ? {} : { port: Number(env.MSSQL_PORT || 1433) }),
  options: {
    encrypt: env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: true,
    ...(env.MSSQL_INSTANCE ? { instanceName: env.MSSQL_INSTANCE } : {}),
    ...(env.MSSQL_TLS_MIN_VERSION
      ? { cryptoCredentialsDetails: { minVersion: env.MSSQL_TLS_MIN_VERSION } }
      : {}),
  },
};

console.log(`Node.js ${process.version}`);
let pool;
try {
  pool = await new sql.ConnectionPool(config).connect();
  const version = await pool.request().query('SELECT @@VERSION AS v');
  console.log('接続OK');
  console.log(`サーバーバージョン: ${String(version.recordset[0].v).split('\n')[0]}`);

  const args = process.argv.slice(2);
  if (args.length === 0) console.log('SQLファイルの指定がないため、接続確認のみで終了します');
  await runSqlFiles(args, '@', async (stmt, binds) => {
    const request = pool.request();
    for (const [name, value] of Object.entries(binds)) request.input(name, value);
    const result = await request.query(stmt);
    return result.recordset ?? [];
  });
} catch (e) {
  console.error(`エラー: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool?.close();
}
