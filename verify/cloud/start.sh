#!/usr/bin/env bash
# クラウドの Claude Code の環境で、Docker の SQL Server（架空の DB「検証」）と code-server を起こす。何度実行してもよい。
# 環境が止まって起き直したとき（dockerd と code-server が止まる）も、これを実行すれば戻る。
#
# 使い方：verify/cloud/start.sh [拡張の vsix]
#   vsix を渡すと、code-server に入れ直してから起こす（pnpm --filter sql-editor-tool package:vsix で作ったもの）
#
# 作業フォルダ（WORK。既定 /tmp/sql-editor-tool-verify）に置くもの：
#   .dbpw（SQL Server の sa のパスワード。初回に作る。画面やログに出さない）、cs（code-server）、csud・csext（設定と拡張）、
#   ws（開くフォルダ。ws/ の .sql を写す）、pwprofile（Playwright のブラウザのプロファイル）、shots（スクリーンショット）、ログ
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-/tmp/sql-editor-tool-verify}"
MSSQL_PORT="${MSSQL_PORT:-14330}"
CS_PORT="${CS_PORT:-18080}"
VSIX="${1:-}"
mkdir -p "$WORK"

# sa のパスワード（SQL Server の複雑さの規則を満たす）
if [ ! -s "$WORK/.dbpw" ]; then
  (umask 077 && printf 'Vf%s#9' "$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)" > "$WORK/.dbpw")
fi
sqlcmd() {
  SQLCMDPASSWORD="$(cat "$WORK/.dbpw")" docker exec -e SQLCMDPASSWORD -i mssql \
    /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -f 65001 -b "$@"
}

# Docker
if ! docker info >/dev/null 2>&1; then
  pgrep -x dockerd >/dev/null || (nohup dockerd >>"$WORK/dockerd.log" 2>&1 &)
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

# SQL Server 2022（社内は 2012 SP2 なので、版による違いは会社 PC で確かめる）
if ! docker inspect mssql >/dev/null 2>&1; then
  (umask 077 && printf 'ACCEPT_EULA=Y\nMSSQL_COLLATION=Japanese_CI_AS\nMSSQL_SA_PASSWORD=%s\n' "$(cat "$WORK/.dbpw")" > "$WORK/mssql.env")
  docker run -d --name mssql --env-file "$WORK/mssql.env" -p "$MSSQL_PORT:1433" \
    mcr.microsoft.com/mssql/server:2022-latest >/dev/null
  rm -f "$WORK/mssql.env"
fi
docker start mssql >/dev/null
ready=""
for _ in $(seq 1 90); do
  if sqlcmd -Q "SELECT 1" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "SQL Server につながりません（前からある mssql のコンテナなら、そのパスワードを $WORK/.dbpw に置いてください）" >&2
  exit 1
fi
if [ "$(sqlcmd -h -1 -W -Q "SET NOCOUNT ON; SELECT CASE WHEN DB_ID(N'検証') IS NULL THEN 0 ELSE 1 END")" != "1" ]; then
  docker cp "$HERE/mssql/setup.sql" mssql:/tmp/setup.sql
  sqlcmd -i /tmp/setup.sql >/dev/null
  echo "架空の DB「検証」を作りました"
fi
echo "SQL Server：localhost:$MSSQL_PORT、DB「検証」、ユーザー sa（パスワードは $WORK/.dbpw）"

# code-server
CS="$WORK/cs/node_modules/.bin/code-server"
[ -x "$CS" ] || bash "$HERE/install-code-server.sh" "$WORK/cs"
mkdir -p "$WORK/csud/User" "$WORK/csext" "$WORK/ws" "$WORK/shots"
[ -f "$WORK/csud/User/settings.json" ] || cp "$HERE/code-server/settings.json" "$WORK/csud/User/settings.json"
cp -n "$HERE"/ws/*.sql "$WORK/ws/" 2>/dev/null || true
running() { curl -s -o /dev/null "http://127.0.0.1:$CS_PORT/"; }
if [ -n "$VSIX" ]; then
  if [ -f "$WORK/cs.pid" ]; then kill "$(cat "$WORK/cs.pid")" 2>/dev/null || true; sleep 2; fi
  # 前の版は消してから入れる（古い版が残ると、どちらが動くか分からない）
  rm -rf "$WORK"/csext/ishibashi0112.sql-editor-tool-*
  node "$CS" --user-data-dir "$WORK/csud" --extensions-dir "$WORK/csext" --install-extension "$VSIX" --force
fi
if ! running; then
  nohup node "$CS" --auth none --bind-addr "127.0.0.1:$CS_PORT" --user-data-dir "$WORK/csud" \
    --extensions-dir "$WORK/csext" --disable-telemetry --disable-update-check "$WORK/ws" >"$WORK/cs.log" 2>&1 &
  echo $! > "$WORK/cs.pid"
  for _ in $(seq 1 60); do running && break; sleep 1; done
fi
running || { echo "code-server が起きません（$WORK/cs.log）" >&2; exit 1; }
echo "code-server：http://127.0.0.1:$CS_PORT/（開くフォルダ $WORK/ws）"
