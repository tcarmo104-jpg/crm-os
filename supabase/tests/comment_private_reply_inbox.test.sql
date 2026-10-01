-- Pruebas de 0033: una respuesta privada a un comentario crea (o reutiliza) una conversación real en el
-- Inbox, con el mensaje ya marcado como enviado (nunca pasa por el despachador genérico de envíos).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-c333-0000-0000-00000000000a'''
\set V1 '''61000000-c333-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@pr.test'), (:V1, 'v1@pr.test');
select t.as_user(:A); select t.save('org', public.create_organization('Respuesta Privada Test', 'respuesta-privada-test')); select t.reset();
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :V1::uuid, r.id from public.roles r where r.key = 'marketing' and r.org_id is null;
select t.as_user(:A); select t.save('fb', public.connect_channel(t.id('org'), 'facebook', 'Página QA', '2200002', null, 'Página QA', 'token-fb-abcdefghijklmnop')); select t.reset();
select t.as_service();
select public.ingest_social_comment('facebook', '2200002', '3300001', '4400001', null, '5500001', 'Juan Pérez', '¿Cuánto cuesta?', 'add', now());
select t.reset();
select t.save('comment', (select id from public.social_comments where external_id = '4400001'));

-- ---- La primera respuesta privada crea un cliente y una conversación nuevos
select t.as_user(:V1);
select t.save('msg', public.record_comment_reply(t.id('comment'), 'private', 'El precio es $50.000. ¿Te interesa?'));
select t.reset();
select t.ok('se creó un cliente nuevo a partir del comentarista', (select count(*) = 1 from public.customers where org_id = t.id('org')));
select t.ok('se creó una conversación de Facebook con su número/psid como hilo', (select count(*) = 1 from public.conversations conv join public.channels ch on ch.id = conv.channel_id where ch.kind = 'facebook' and conv.thread_key = '5500001'));
select t.ok('el mensaje quedó guardado como SALIENTE y ya «enviado» (no «en cola»)', (select direction = 'outbound' and status = 'sent' and body = 'El precio es $50.000. ¿Te interesa?' from public.messages where id = t.id('msg')));
select t.ok('la conversación queda abierta y sin pendiente de respuesta', (select status = 'open' and needs_reply = false from public.conversations where thread_key = '5500001'));

-- ---- Una segunda respuesta privada a OTRO comentario de la MISMA persona reutiliza la conversación (no crea otro cliente)
select t.as_service();
select public.ingest_social_comment('facebook', '2200002', '3300002', '4400002', null, '5500001', 'Juan Pérez', 'Otra pregunta', 'add', now());
select t.reset();
select t.save('comment2', (select id from public.social_comments where external_id = '4400002'));
select t.as_user(:V1);
select public.record_comment_reply(t.id('comment2'), 'private', 'Con gusto te ayudo con eso también.');
select t.reset();
select t.ok('sigue habiendo un solo cliente (no se duplicó)', (select count(*) = 1 from public.customers where org_id = t.id('org')));
select t.ok('sigue habiendo una sola conversación (se reutilizó)', (select count(*) = 1 from public.conversations where thread_key = '5500001'));
select t.ok('ahora hay 2 mensajes salientes en esa conversación', (select count(*) = 2 from public.messages where conversation_id = (select id from public.conversations where thread_key = '5500001')));

-- ---- No se puede mandar una respuesta privada vacía
select t.as_user(:V1);
select t.throws('una respuesta privada vacía se rechaza', format('select public.record_comment_reply(%L, ''private'', '''')', t.id('comment')), '22023');
select t.reset();

rollback;
\echo ✔ RESPUESTA PRIVADA CONECTADA AL INBOX: TODAS LAS PRUEBAS PASARON
