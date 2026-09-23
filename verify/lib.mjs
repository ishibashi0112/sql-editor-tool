// 検証スクリプト共通の処理
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');
const PREVIEW_ROWS = 50;

/** パスワードを画面に表示せずに入力させる */
export function promptHidden(label) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(label);
    rl._writeToOutput = () => {}; // 入力した文字を表示しない
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/** 判定用に、文字列リテラルとコメントを取り除いたテキストを返す */
export function stripForAnalysis(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 行末の ; で文を分割し、コメントだけの塊は捨てる */
export function splitStatements(sql) {
  return sql
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => stripForAnalysis(s).trim().length > 0);
}

/** SELECT / WITH 以外は実行しない（読み取り専用の原則） */
export function assertReadOnly(stmt) {
  const head = stripForAnalysis(stmt).trim().split(/\s+/)[0]?.toUpperCase();
  if (head !== 'SELECT' && head !== 'WITH') {
    throw new Error(`SELECT / WITH 以外の文は実行しません（先頭: ${head}）`);
  }
}

/** <TABLE> のようなプレースホルダが残っていたら止める */
export function assertNoPlaceholder(stmt) {
  const m = stripForAnalysis(stmt).match(/<[A-Z_]+>/);
  if (m) throw new Error(`プレースホルダ ${m[0]} が残っています。SQLファイルを書き換えてから実行してください`);
}

/** 文中のバインド変数名を抽出する（prefix は ':' か '@'） */
export function extractBindNames(stmt, prefix) {
  const text = stripForAnalysis(stmt);
  const re =
    prefix === ':'
      ? /(?<![:\p{L}\p{N}_]):([\p{L}\p{N}_]+)/gu
      : /(?<![@\p{L}\p{N}_])@([\p{L}\p{N}_]+)/gu;
  return [...new Set([...text.matchAll(re)].map((m) => m[1]))];
}

/** BIND_<名前> の環境変数からバインド値を集める */
export function resolveBinds(names) {
  const binds = {};
  for (const name of names) {
    const key = `BIND_${name.toUpperCase()}`;
    const value = process.env[key];
    if (value === undefined || value === '') {
      throw new Error(`バインド変数 ${name} の値がありません。.env に ${key} を設定してください`);
    }
    binds[name] = value;
  }
  return binds;
}

/** Excelで開けるよう BOM 付き UTF-8 の CSV で保存する */
function writeCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (rows.length === 0) {
    fs.writeFileSync(file, '\uFEFF', 'utf8');
    return;
  }
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))];
  fs.writeFileSync(file, `\uFEFF${lines.join('\r\n')}`, 'utf8');
}

/** 引数（ファイルまたはフォルダ）を .sql ファイルの一覧に展開する。フォルダは直下のみ */
function expandSqlFiles(args) {
  const files = [];
  for (const arg of args) {
    if (fs.statSync(arg).isDirectory()) {
      const inDir = fs
        .readdirSync(arg)
        .filter((f) => f.toLowerCase().endsWith('.sql'))
        .sort()
        .map((f) => path.join(arg, f));
      files.push(...inDir);
    } else {
      files.push(arg);
    }
  }
  return files;
}

/**
 * SQLファイルを順に実行し、結果を画面（先頭のみ）と out/ の CSV に出す。
 * 実行前に全ファイルの全文を検査し、1つでも問題があれば何も実行しない。
 */
export async function runSqlFiles(args, bindPrefix, execute) {
  const files = expandSqlFiles(args);
  const plan = [];
  for (const file of files) {
    const base = path.basename(file, path.extname(file));
    const statements = splitStatements(fs.readFileSync(file, 'utf8'));
    for (const [i, stmt] of statements.entries()) {
      assertReadOnly(stmt);
      assertNoPlaceholder(stmt);
      const binds = resolveBinds(extractBindNames(stmt, bindPrefix));
      plan.push({ label: `${base} #${i + 1}`, csv: path.join(OUT_DIR, `${base}_${i + 1}.csv`), stmt, binds });
    }
  }

  for (const { label, csv, stmt, binds } of plan) {
    const rows = await execute(stmt, binds);
    console.log(`\n=== ${label}（${rows.length} 行） ===`);
    console.table(rows.slice(0, PREVIEW_ROWS));
    if (rows.length > PREVIEW_ROWS) console.log(`…先頭 ${PREVIEW_ROWS} 行のみ表示。全件は CSV を参照`);
    writeCsv(csv, rows);
  }
  if (plan.length > 0) console.log(`\nCSV の出力先: ${OUT_DIR}`);
}
