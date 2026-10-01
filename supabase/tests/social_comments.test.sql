-- Pruebas de 0032: comentarios de Facebook e Instagram — ingesta, permisos, y las acciones (ocultar,
-- eliminar, responder) solo las puede hacer quien tiene comments:manage.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-c222-0000-0000-00000000000a'''
\set S1 '''51000000-c222-0000-0000-000000000001'''
\set V1 '''61000000-c222-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@sc.test'), (:S1, 's1@sc.test'), (:V1, 'v1@sc.test');
select t.as_user(:A); select t.save('org', public.create_organization('Comentarios Test', 'comentarios-test')); select t.reset();
-- S1: sales_agent (sin comments:manage por diseño); V1: marketing (sí tiene)
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :S1::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :V1::uuid, r.id from public.roles r where r.key = 'marketing' and r.org_id is null;
select t.as_user(:A); select t.save('fb', public.connect_channel(t.id('org'), 'facebook', 'Página QA', '2200001', null, 'Página QA', 'token-fb-abcdefghijklmnop')); select t.reset();

-- ---- Ingesta de un comentario nuevo (solo el servidor puede llamarla)
select t.as_user(:A);
select t.throws('un usuario normal no puede ingestar un comentario directamente',
  'select public.ingest_social_comment(''facebook'', ''2200001'', ''3300001'', ''4400001'', null, ''5500001'', ''Juan Pérez'', ''¿Cuánto cuesta?'', ''add'', now())', '42501');
select t.reset();

select t.as_service();
select public.ingest_social_comment('facebook', '2200001', '3300001', '4400001', null, '5500001', 'Juan Pérez', '¿Cuánto cuesta?', 'add', now());
select t.reset();
select t.save('comment', (select id from public.social_comments where external_id = '4400001'));
select t.ok('el comentario se guardó con su texto y autor', (select message = '¿Cuánto cuesta?' and author_name = 'Juan Pérez' from public.social_comments where id = t.id('comment')));
select t.ok('la publicación se creó sola la primera vez que se vio', (select count(*) = 1 from public.social_posts where external_id = '3300001'));
select t.ok('queda «visible» por defecto', (select status = 'visible' from public.social_comments where id = t.id('comment')));

-- ---- Un vendedor (sin comments:read) no ve nada; marketing (con el permiso) sí
select t.as_user(:S1);
select t.ok('un vendedor sin comments:read no ve el comentario', (select count(*) = 0 from public.social_comments where id = t.id('comment')));
select t.reset();
select t.as_user(:V1);
select t.ok('marketing sí lo ve (tiene comments:read)', (select count(*) = 1 from public.social_comments where id = t.id('comment')));
select t.reset();

-- ---- La publicación (social_posts) tiene la misma guarda que los comentarios
select t.as_user(:S1);
select t.ok('un vendedor sin comments:read tampoco ve la publicación', (select count(*) = 0 from public.social_posts where external_id = '3300001'));
select t.reset();
select t.as_user(:V1);
select t.ok('marketing sí ve la publicación', (select count(*) = 1 from public.social_posts where external_id = '3300001'));
select t.reset();

-- ---- Ocultar / eliminar: solo quien tiene comments:manage
select t.as_user(:S1);
select t.throws('un vendedor no puede ocultar un comentario (no tiene comments:manage)', format('select public.set_comment_status(%L, ''hidden'')', t.id('comment')), '42501');
select t.reset();

select t.as_user(:V1);
select public.set_comment_status(t.id('comment'), 'hidden');
select t.reset();
select t.ok('marketing sí puede ocultarlo', (select status = 'hidden' from public.social_comments where id = t.id('comment')));

-- ---- Registrar una respuesta pública y una privada
select t.as_user(:V1);
select public.record_comment_reply(t.id('comment'), 'public', 'Te escribimos por privado con el precio.');
select t.reset();
select t.ok('la respuesta pública queda registrada con su texto y fecha', (select replied_publicly_at is not null and replied_publicly_text = 'Te escribimos por privado con el precio.' from public.social_comments where id = t.id('comment')));

select t.as_user(:V1);
select public.record_comment_reply(t.id('comment'), 'private', 'El precio es $50.000.');
select t.reset();
select t.ok('la respuesta privada queda marcada con su fecha', (select private_reply_at is not null from public.social_comments where id = t.id('comment')));

-- ---- Un comentario de alguien que YA es cliente del CRM se enlaza solo
select t.as_user(:A);
select t.save('cust', (public.create_customer(t.id('org'), 'person', 'María Cliente', '[{"type":"facebook","value":"6600002"}]'::jsonb, '{}'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_service();
select public.ingest_social_comment('facebook', '2200001', '3300001', '4400002', null, '6600002', 'María Cliente', 'Hola de nuevo', 'add', now());
select t.reset();
select t.ok('el comentario queda enlazado al cliente que ya existía', (select customer_id = t.id('cust') from public.social_comments where external_id = '4400002'));

-- ---- verb=remove marca como eliminado y conserva el texto anterior (no lo borra del CRM)
select t.as_service();
select public.ingest_social_comment('facebook', '2200001', '3300001', '4400002', null, '6600002', 'María Cliente', null, 'remove', now());
select t.reset();
select t.ok('verb=remove lo marca eliminado sin perder el texto que tenía', (select status = 'deleted' and message = 'Hola de nuevo' from public.social_comments where external_id = '4400002'));

-- ---- Una respuesta a un comentario (no al post) guarda su parent_external_id
select t.as_service();
select public.ingest_social_comment('facebook', '2200001', '3300001', '4400003', '4400001', '7700001', 'Otra Persona', 'De acuerdo con Juan', 'add', now());
select t.reset();
select t.ok('la respuesta a un comentario guarda cuál es su comentario padre', (select parent_external_id = '4400001' from public.social_comments where external_id = '4400003'));

rollback;
\echo ✔ COMENTARIOS DE FACEBOOK/INSTAGRAM: TODAS LAS PRUEBAS PASARON
