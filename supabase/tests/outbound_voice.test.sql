-- Pruebas de 0029: la nota de voz grabada y enviada queda marcada como tal (is_voice), sin afectar un
-- archivo normal enviado igual que siempre.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-c888-0000-0000-00000000000a'''
\set S1 '''51000000-c888-0000-0000-000000000001'''
\set PID '''329876543211'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values (:A, 'a@ov.test'), (:S1, 's1@ov.test');
select t.as_user(:A); select t.save('org', public.create_organization('Voz Test', 'voz-test')); select t.reset();
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :S1::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
select t.as_user(:A);
select t.save('wa', public.create_channel(t.id('org'), 'Ventas', :PID, '+57 300 000 0001', 'EAAB-token-abcdefghijklmnopqrstuvwxyz'));
select public.create_customer(t.id('org'), 'person', 'Cliente Voz', '[{"type":"phone","value":"+573001110080"}]'::jsonb);
select t.reset();
select t.as_service();
select public.ingest_whatsapp_message(:PID, '573001110080', 'Cliente Voz', 'wamid.v1', 'text', 'hola', now());
select t.reset();
select t.save('conv', (select id from public.conversations where thread_key = '573001110080'));

-- ---- Una nota de voz grabada (is_voice = true) queda marcada en el mensaje
select t.as_user(:A);
select t.save('voice', (public.create_attachment_upload(t.id('conv'), 'nota-de-voz.ogg', 'audio/ogg', 15000, true) ->> 'id')::uuid);
select t.reset();
select t.as_service(); select public.verify_attachment_upload(t.id('voice'), 'audio', 'audio/ogg', 15000); select t.reset();
select t.as_user(:A); select t.save('msg1', public.queue_media_message(t.id('conv'), array[t.id('voice')]::uuid[], null));
select t.reset();
select t.ok('el adjunto queda marcado como nota de voz', (select is_voice from public.message_attachments where message_id = t.id('msg1')));
select t.ok('sin pie de foto, el mensaje se etiqueta «Nota de voz» (no «Audio»)', (select body = '[Nota de voz]' from public.messages where id = t.id('msg1')));

-- ---- Un audio normal (adjuntado como archivo, no grabado) NO queda marcado
select t.as_user(:A);
select t.save('normal', (public.create_attachment_upload(t.id('conv'), 'cancion.mp3', 'audio/mpeg', 20000) ->> 'id')::uuid);
select t.reset();
select t.as_service(); select public.verify_attachment_upload(t.id('normal'), 'audio', 'audio/mpeg', 20000); select t.reset();
select t.as_user(:A); select t.save('msg2', public.queue_media_message(t.id('conv'), array[t.id('normal')]::uuid[], null));
select t.reset();
select t.ok('un audio adjuntado normal NO se marca como nota de voz', (select is_voice = false from public.message_attachments where message_id = t.id('msg2')));
select t.ok('ese mensaje se etiqueta «Audio», no «Nota de voz»', (select body = '[Audio]' from public.messages where id = t.id('msg2')));

rollback;
\echo ✔ NOTAS DE VOZ ENVIADAS: TODAS LAS PRUEBAS PASARON
