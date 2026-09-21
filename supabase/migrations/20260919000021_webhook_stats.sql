-- =============================================================================
-- 0021 DIAGNÓSTICO DE RECEPCIÓN: qué pasa cuando Meta llama al CRM
-- =============================================================================
-- Hasta ahora, si Meta llamaba al webhook y algo fallaba (firma inválida por una clave equivocada, token de verificación distinto,
-- variable ausente), solo quedaba una línea en los registros internos de Vercel: desde el CRM era imposible saber si Meta NO llega,
-- si llega y se RECHAZA, o si llega y no se procesa. Esta tabla cuenta, por día y por resultado, cada llamada (sin guardar ningún
-- contenido, ninguna clave ni datos de clientes) para que el CRM pueda decirlo con claridad.
-- =============================================================================
create table public.webhook_stats (
  day     date        not null default current_date,
  outcome text        not null check (outcome in ('verify_ok', 'verify_rejected', 'accepted', 'bad_signature', 'no_secret', 'bad_payload')),
  hits    integer     not null default 0 check (hits >= 0),
  last_at timestamptz not null default now(),
  primary key (day, outcome)
);
alter table public.webhook_stats enable row level security;
revoke all on public.webhook_stats from anon, authenticated;       -- solo el servidor la toca, por las funciones de abajo

create or replace function public.bump_webhook_stat(p_outcome text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.webhook_stats (day, outcome, hits) values (current_date, p_outcome, 1)
  on conflict (day, outcome) do update set hits = public.webhook_stats.hits + 1, last_at = now();
  -- Limpieza barata y ocasional: solo se conservan 30 días.
  if random() < 0.02 then delete from public.webhook_stats where day < current_date - 30; end if;
end $$;

create or replace function public.webhook_stats_summary(p_days integer default 14) returns table (outcome text, hits bigint, last_at timestamptz)
language sql security definer set search_path = '' stable as $$
  select s.outcome, sum(s.hits)::bigint, max(s.last_at) from public.webhook_stats s where s.day >= current_date - greatest(p_days, 1) group by s.outcome
$$;

revoke all on function public.bump_webhook_stat(text), public.webhook_stats_summary(integer) from public, anon, authenticated;
grant execute on function public.bump_webhook_stat(text), public.webhook_stats_summary(integer) to service_role;
