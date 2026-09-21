-- Pruebas de 0021: contador de llamadas del webhook (sin contenido, solo cuántas y cuándo).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

begin;
\i supabase/tests/support/test_helpers.sql

select t.as_service();
select public.bump_webhook_stat('bad_signature');
select public.bump_webhook_stat('bad_signature');
select public.bump_webhook_stat('accepted');
select public.bump_webhook_stat('verify_rejected');
select t.reset();
select t.ok('cuenta cada llamada por resultado',
  (select hits = 2 from public.webhook_stats_summary(14) where outcome = 'bad_signature')
  and (select hits = 1 from public.webhook_stats_summary(14) where outcome = 'accepted')
  and (select hits = 1 from public.webhook_stats_summary(14) where outcome = 'verify_rejected'));
select t.ok('...y guarda cuándo fue la última', (select last_at > now() - interval '1 minute' from public.webhook_stats_summary(14) where outcome = 'bad_signature'));
select t.ok('lo que no ha ocurrido no aparece', (select count(*) = 0 from public.webhook_stats_summary(14) where outcome = 'verify_ok'));
select t.as_service(); select t.throws('un resultado inventado se rechaza', 'select public.bump_webhook_stat(''hackeado'')', '23514'); select t.reset();

insert into public.webhook_stats (day, outcome, hits, last_at) values (current_date - 20, 'no_secret', 7, now() - interval '20 days');
select t.ok('el resumen respeta la ventana de días', (select count(*) = 0 from public.webhook_stats_summary(14) where outcome = 'no_secret') and (select hits = 7 from public.webhook_stats_summary(30) where outcome = 'no_secret'));

select t.as_user('aaaaaaaa-c999-0000-0000-00000000000a');
select t.throws('un usuario no lee la tabla', 'select count(*) from public.webhook_stats', '42501');
select t.throws('ni llama a las funciones', 'select public.bump_webhook_stat(''accepted'')', '42501');
select t.throws('ni al resumen', 'select * from public.webhook_stats_summary(14)', '42501');
select t.reset();
select t.as_anon(); select t.throws('un anónimo tampoco', 'select public.bump_webhook_stat(''accepted'')', '42501'); select t.reset();
select t.ok('todas las tablas tienen RLS', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);

rollback;
\echo ✔ ESTADÍSTICAS DEL WEBHOOK: TODAS LAS PRUEBAS PASARON
