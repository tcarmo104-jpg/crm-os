-- Pruebas de 0030: `ingest_channel_message` avisa si al cliente le falta la foto, sea conversación nueva o
-- ya existente (así el CRM sabe cuándo volver a pedirla, sin pisar una que ya esté guardada).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-f111-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@bf.test');
select t.as_user(:A); select t.save('org', public.create_organization('Backfill Test', 'backfill-test')); select t.reset();
select t.as_user(:A); select t.save('fb', public.connect_channel(t.id('org'), 'facebook', 'Página QA', '7000001', null, 'Página QA', 'token-fb-abcdefghijklmnop')); select t.reset();

-- ---- Conversación NUEVA: needs_avatar siempre en true (un cliente recién creado nunca tiene foto)
select t.as_service();
select t.ok('conversación nueva: new_conversation=true',
  (select (public.ingest_channel_message('facebook', '7000001', '8000001', 'Ana', 'fb.n1', 'text', 'hola', now()) ->> 'new_conversation')::boolean));
select t.reset();
select t.save('conv', (select id from public.conversations where thread_key = '8000001'));

select t.as_service();
select t.ok('conversación nueva: needs_avatar=true (todavía no tiene foto)',
  (select avatar_url is null from public.customers where id = (select customer_id from public.conversations where id = t.id('conv'))));
select t.reset();

-- ---- Un segundo mensaje en la MISMA conversación (todavía sin foto): needs_avatar sigue en true
select t.as_service();
select t.ok('la misma conversación, sin foto todavía: needs_avatar sigue true',
  (select (public.ingest_channel_message('facebook', '7000001', '8000001', 'Ana', 'fb.n2', 'text', 'otro mensaje', now()) ->> 'needs_avatar')::boolean));
select t.ok('esta vez ya NO es una conversación nueva',
  (select not (public.ingest_channel_message('facebook', '7000001', '8000001', 'Ana', 'fb.n2b', 'text', 'otro mensaje más', now()) ->> 'new_conversation')::boolean));
select t.reset();

-- ---- Una vez que la foto se guarda, needs_avatar pasa a false y ya no se vuelve a pedir
select t.as_service();
select public.set_contact_profile(t.id('conv'), 'Ana Gómez', 'https://scontent.fbcdn.net/v/foto-ana.jpg');
select t.ok('con la foto ya guardada, needs_avatar pasa a false',
  (select not (public.ingest_channel_message('facebook', '7000001', '8000001', 'Ana', 'fb.n3', 'text', 'tercer mensaje', now()) ->> 'needs_avatar')::boolean));
select t.reset();
select t.ok('la foto sigue siendo la misma (no se volvió a pisar)', (select avatar_url = 'https://scontent.fbcdn.net/v/foto-ana.jpg' from public.customers where id = (select customer_id from public.conversations where id = t.id('conv'))));

rollback;
\echo ✔ RECUPERAR FOTO EN CONVERSACIONES VIEJAS: TODAS LAS PRUEBAS PASARON
