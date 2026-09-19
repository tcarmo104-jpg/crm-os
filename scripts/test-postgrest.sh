#!/usr/bin/env bash
# Pruebas de INTEGRACIÓN: repositorios y ruta de API reales contra PostgREST + Postgres con las migraciones.
# Requiere el binario de PostgREST (PGRST_BIN, por defecto /tmp/pgrest/postgrest).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${TEST_DB:-crm_pgrest}"
PGRST_BIN="${PGRST_BIN:-/tmp/pgrest/postgrest}"
SECRET="test-secret-test-secret-test-secret-123"
[ -x "$PGRST_BIN" ] || { echo "Falta PostgREST en $PGRST_BIN (https://github.com/PostgREST/postgrest/releases)"; exit 1; }

dropdb --if-exists "$DB"; createdb "$DB"
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/support/supabase_stub.sql
for f in supabase/migrations/*.sql; do psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
psql -X -q -d "$DB" <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit password 'x'; end if;
end \$\$;
grant anon, authenticated, service_role to authenticator;
SQL

cat > /tmp/pgrst.conf <<CONF
db-uri = "postgres://authenticator:x@127.0.0.1:5432/$DB"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRET"
server-host = "127.0.0.1"
server-port = 3222
CONF
"$PGRST_BIN" /tmp/pgrst.conf >/tmp/pgrst.log 2>&1 &
PG_PID=$!
node scripts/rest-proxy.mjs 3333 3222 &
PROXY_PID=$!
trap 'kill $PG_PID $PROXY_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:3222/ && break; sleep 0.5; done
curl -s -o /dev/null http://127.0.0.1:3222/ || { echo "PostgREST no arrancó:"; cat /tmp/pgrst.log; exit 1; }

INTEGRATION=1 REST_URL=http://127.0.0.1:3333 JWT_SECRET="$SECRET" INT_DB="$DB" npx vitest run src/integration
