#!/usr/bin/env bash
# Aplica las migraciones sobre una base limpia y ejecuta las pruebas SQL.
# Uso: TEST_DB=crm_test bash scripts/test-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${TEST_DB:-crm_test}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -d "$DB")

dropdb --if-exists "$DB"
createdb "$DB"
"${PSQL[@]}" -f supabase/tests/support/supabase_stub.sql
for f in supabase/migrations/*.sql; do
  echo "→ aplicando $f"
  "${PSQL[@]}" -f "$f"
done
for f in supabase/tests/*.test.sql; do
  echo "→ ejecutando $f"
  "${PSQL[@]}" -f "$f"
done
echo "→ ejecutando scripts/test-concurrency.sh"
TEST_DB="$DB" bash scripts/test-concurrency.sh
echo "✔ migraciones y pruebas OK"
