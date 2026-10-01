-- Pruebas de 0031: la foto se vuelve a revisar pasados 30 días, y se marca como «revisada» incluso cuando
-- Meta no devuelve ninguna (para no insistir en cada mensaje).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-f222-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@rf.test');
select t.as_user(:A); select t.save('org', public.create_organization('Refresh Test', 'refresh-test')); select t.reset();
select t.as_user(:A); select t.save('fb', public.connect_channel(t.id('org'), 'facebook', 'Página QA', '9000001', null, 'Página QA', 'token-fb-abcdefghijklmnop')); select t.reset();
select t.as_service(); select public.ingest_channel_message('facebook', '9000001', '9100001', 'Ana', 'fb.r1', 'text', 'hola', now()); select t.reset();
select t.save('conv', (select id from public.conversations where thread_key = '9100001'));
select t.save('cust', (select customer_id from public.conversations where id = t.id('conv')));

-- ---- Primera foto: se guarda, y queda marcada como revisada
select t.as_service();
select public.set_contact_profile(t.id('conv'), 'Ana Gómez', 'https://scontent.fbcdn.net/v/foto-v1.jpg');
select t.reset();
select t.ok('la primera foto se guarda', (select avatar_url = 'https://scontent.fbcdn.net/v/foto-v1.jpg' from public.customers where id = t.id('cust')));
select t.ok('queda marcada como revisada hace un instante', (select avatar_checked_at > now() - interval '5 seconds' from public.customers where id = t.id('cust')));

-- ---- Recién revisada (hace unos segundos): una foto nueva de Meta NO reemplaza la guardada todavía
select t.as_service();
select public.set_contact_profile(t.id('conv'), 'Ana Gómez', 'https://scontent.fbcdn.net/v/foto-v2-demasiado-pronto.jpg');
select t.reset();
select t.ok('antes de los 30 días, la foto NO cambia aunque Meta mande otra', (select avatar_url = 'https://scontent.fbcdn.net/v/foto-v1.jpg' from public.customers where id = t.id('cust')));

-- ---- Simulamos que ya pasaron 30 días desde la última revisión
select t.as_service();
update public.customers set avatar_checked_at = now() - interval '31 days' where id = t.id('cust');
select public.set_contact_profile(t.id('conv'), 'Ana Gómez', 'https://scontent.fbcdn.net/v/foto-v2.jpg');
select t.reset();
select t.ok('pasados 30 días, SÍ se actualiza a la foto nueva', (select avatar_url = 'https://scontent.fbcdn.net/v/foto-v2.jpg' from public.customers where id = t.id('cust')));
select t.ok('y vuelve a quedar marcada como revisada ahora', (select avatar_checked_at > now() - interval '5 seconds' from public.customers where id = t.id('cust')));

-- ---- Si Meta no devuelve ninguna foto esta vez, igual se marca como revisado (no se borra la que había)
select t.as_service();
update public.customers set avatar_checked_at = now() - interval '31 days' where id = t.id('cust');
select public.set_contact_profile(t.id('conv'), 'Ana Gómez', null);
select t.reset();
select t.ok('sin foto nueva de Meta, la que ya había NO se borra', (select avatar_url = 'https://scontent.fbcdn.net/v/foto-v2.jpg' from public.customers where id = t.id('cust')));
select t.ok('pero igual queda marcada como revisada (no se insiste en cada mensaje)', (select avatar_checked_at > now() - interval '5 seconds' from public.customers where id = t.id('cust')));

-- ---- needs_avatar en ingest_channel_message: se enciende de nuevo pasados los 30 días
select t.as_service();
update public.customers set avatar_checked_at = now() - interval '31 days' where id = t.id('cust');
select t.ok('needs_avatar se enciende de nuevo pasados 30 días desde la última revisión',
  (select (public.ingest_channel_message('facebook', '9000001', '9100001', 'Ana', 'fb.r2', 'text', 'otro mensaje', now()) ->> 'needs_avatar')::boolean));
-- Así como lo haría el CRM de verdad: al ver needs_avatar=true, pide el perfil a Meta y llama set_contact_profile,
-- que es quien de verdad actualiza avatar_checked_at (ingest_channel_message por sí sola no lo toca).
select public.set_contact_profile(t.id('conv'), 'Ana Gómez', 'https://scontent.fbcdn.net/v/foto-v3.jpg');
select t.reset();
select t.ok('ya revisada hace unos segundos, needs_avatar NO se enciende en el siguiente mensaje',
  (select not (select (public.ingest_channel_message('facebook', '9000001', '9100001', 'Ana', 'fb.r3', 'text', 'otro más', now()) ->> 'needs_avatar')::boolean)));
select t.reset();

rollback;
\echo ✔ REVISAR LA FOTO CADA 30 DÍAS: TODAS LAS PRUEBAS PASARON
