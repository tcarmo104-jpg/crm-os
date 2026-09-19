#!/usr/bin/env bash
# Genera supabase/setup-all.sql: todas las migraciones en orden, en UNA transacción (o todo o nada),
# para pegarlo una sola vez en el SQL Editor de Supabase (proyecto vacío).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=supabase/setup-all.sql
{
  echo "-- ============================================================================="
  echo "-- CRM OS · INSTALACIÓN COMPLETA DE LA BASE DE DATOS (proyecto Supabase VACÍO)"
  echo "-- Pégalo entero en SQL Editor → New query → Run. Va en UNA transacción: si algo falla,"
  echo "-- no queda nada a medias y puedes corregir y volver a ejecutarlo."
  echo "-- Al final debe mostrar una fila con estado = LISTO."
  echo "-- Generado con scripts/build-setup-sql.sh a partir de supabase/migrations/*.sql"
  echo "-- ============================================================================="
  echo "begin;"
  for f in supabase/migrations/*.sql; do
    echo; echo "-- ---------------- $(basename "$f") ----------------"; cat "$f"; echo
  done
  echo "commit;"
  echo
  cat <<'SQL'
-- Comprobación final: 'tablas' y 'tablas_con_rls' deben ser iguales.
select 'LISTO' as estado,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r') as tablas,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity) as tablas_con_rls,
  (select count(*) from public.permissions) as permisos,
  (select count(*) from public.roles where org_id is null) as roles_base;
SQL
} > "$OUT"
echo "generado $OUT ($(wc -c < "$OUT") bytes)"
