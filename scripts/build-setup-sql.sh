#!/usr/bin/env bash
# Genera un instalador SQL para pegar de una vez en el SQL Editor de Supabase (una sola transacción).
#   build-setup-sql.sh        → supabase/setup-all.sql          (proyecto VACÍO: migraciones 1 a N)
#   build-setup-sql.sh 6      → supabase/setup-desde-0006.sql   (proyecto que YA tiene la 0001 a la 0005)
set -euo pipefail
cd "$(dirname "$0")/.."
FROM="${1:-1}"
if [ "$FROM" = "1" ]; then OUT=supabase/setup-all.sql; else OUT="supabase/setup-desde-$(printf %04d "$FROM").sql"; fi

# Primera tabla que crea cada migración: si ya existe, esa migración ya está instalada.
sentinel() { case "$1" in 6) echo custom_field_definitions;; 7) echo customers;; 8) echo api_keys;; 9) echo pipelines;; 10) echo tasks;; 11) echo products;; 12) echo sales;; 13) echo channels;; 14) echo tags;; 16) echo connection_events;; 17) echo oauth_sessions;; *) echo "";; esac; }

{
  echo "-- ============================================================================="
  if [ "$FROM" = "1" ]; then
    echo "-- CRM OS · INSTALACIÓN COMPLETA (solo para un proyecto Supabase VACÍO)"
  else
    echo "-- CRM OS · ACTUALIZACIÓN: migraciones $(printf %04d "$FROM") en adelante (para un proyecto que YA tiene 0001 a $(printf %04d $((FROM-1))))"
  fi
  echo "-- Pégalo entero en SQL Editor → New query → Run. Va en UNA transacción: si algo falla,"
  echo "-- no queda nada a medias y puedes corregir y volver a ejecutarlo."
  echo "-- Al final debe mostrar una fila con estado = LISTO."
  echo "-- Generado con scripts/build-setup-sql.sh a partir de supabase/migrations/*.sql"
  echo "-- ============================================================================="
  echo "begin;"
  if [ "$FROM" != "1" ]; then
    S="$(sentinel "$FROM")"
    echo "-- Comprobación previa (evita instalar sobre un estado que no corresponde)."
    echo 'do $$ begin'
    echo "  if to_regclass('public.organizations') is null or to_regclass('public.audit_logs') is null then"
    echo "    raise exception 'FALTAN las primeras migraciones (0001 a 0004). Este archivo es solo para proyectos que ya las tienen.';"
    echo "  end if;"
    if [ "$FROM" -ge 6 ]; then
      echo "  if to_regclass('public.invitations') is null then"
      echo "    raise exception 'FALTA la migración 0005 (invitaciones). Avísame para darte el archivo correcto.';"
      echo "  end if;"
    fi
    if [ "$FROM" -ge 9 ]; then
      echo "  if to_regclass('public.tasks') is null and $FROM > 10 then"
      echo "    raise exception 'FALTAN las migraciones de la Fase 3 (0009 y 0010). Avísame para darte el archivo correcto.';"
      echo "  end if;"
    fi
    if [ "$FROM" -ge 15 ]; then
      echo "  if to_regclass('public.tags') is null then"
      echo "    raise exception 'FALTA la migración 0014 (Inbox de tres paneles). Instala primero setup-desde-0014.sql o avísame.';"
      echo "  end if;"
    elif [ "$FROM" -ge 14 ]; then
      echo "  if to_regclass('public.conversations') is null then"
      echo "    raise exception 'FALTA la migración 0013 (Inbox de WhatsApp). Instala primero setup-desde-0013.sql o avísame.';"
      echo "  end if;"
    elif [ "$FROM" -ge 13 ]; then
      echo "  if to_regclass('public.sales') is null then"
      echo "    raise exception 'FALTAN las migraciones de la Fase 4 (0011 y 0012). Instala primero setup-desde-0011.sql o avísame.';"
      echo "  end if;"
    fi
    if [ "$FROM" -ge 16 ]; then
      echo "  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'opportunities' and column_name = 'number') then"
      echo "    raise exception 'FALTA la migración 0015 (Oportunidades). Instala primero setup-desde-0015.sql o avísame.';"
      echo "  end if;"
    fi
    if [ "$FROM" = "17" ]; then
      echo "  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'channels' and column_name = 'connection_status') then"
      echo "    raise exception 'FALTA la migración 0016 (Conexiones de WhatsApp). Instala primero setup-desde-0016.sql o avísame.';"
      echo "  end if;"
    fi
    if [ "$FROM" = "16" ]; then
      echo "  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'channels' and column_name = 'connection_status') then"
      echo "    raise exception 'Este proyecto YA tiene instalada la migración 0016 (existe la columna connection_status en channels). Si falta solo la 0017, usa setup-desde-0017.sql.';"
      echo "  end if;"
    fi
    if [ "$FROM" = "15" ]; then
      echo "  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'opportunities' and column_name = 'number') then"
      echo "    raise exception 'Este proyecto YA tiene instalada la migración 0015 (existe la columna number en opportunities). No ejecutes este archivo: avísame.';"
      echo "  end if;"
    fi
    if [ -n "$S" ]; then
      echo "  if to_regclass('public.$S') is not null then"
      echo "    raise exception 'Este proyecto YA tiene instalada la migración $(printf %04d "$FROM") (existe la tabla $S). No ejecutes este archivo: avísame.';"
      echo "  end if;"
    fi
    echo 'end $$;'
  fi
  for f in supabase/migrations/*.sql; do
    n=$(basename "$f" | sed -E 's/^[0-9]{8}0*([0-9]+)_.*/\1/')
    [ "$n" -ge "$FROM" ] || continue
    echo; echo "-- ---------------- $(basename "$f") ----------------"; cat "$f"; echo
  done
  echo "commit;"
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
