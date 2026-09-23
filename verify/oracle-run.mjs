// Oracle への接続確認（Thin モード）と SQL ファイルの実行
// 使い方: node oracle-run.mjs [SQLファイルまたはフォルダ ...]
import 'dotenv/config';
import oracledb from 'oracledb';
import { promptHidden, runSqlFiles } from './lib.mjs';

const user = process.env.ORACLE_USER;
const connectString = process.env.ORACLE_CONNECT_STRING;
if (!user || !connectString) {
  console.error('.env に ORACLE_USER と ORACLE_CONNECT_STRING を設定してください');
  process.exit(1);
}
const password = process.env.ORACLE_PASSWORD || (await promptHidden('Oracle パスワード: '));

console.log(`Node.js ${process.version}`);
let conn;
try {
  conn = await oracledb.getConnection({ user, password, connectString });
  console.log(`接続OK（Thinモード: ${conn.thin}）`);
  console.log(`サーバーバージョン: ${conn.oracleServerVersionString}`);

  const args = process.argv.slice(2);
  if (args.length === 0) console.log('SQLファイルの指定がないため、接続確認のみで終了します');
  await runSqlFiles(args, ':', async (stmt, binds) => {
    const result = await conn.execute(stmt, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      maxRows: 10000, // 検証用なので上限を設ける
    });
    return result.rows ?? [];
  });
} catch (e) {
  console.error(`エラー: ${e.message}`);
  process.exitCode = 1;
} finally {
  await conn?.close();
}
