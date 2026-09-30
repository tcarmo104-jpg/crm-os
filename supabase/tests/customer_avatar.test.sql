-- Pruebas de 0028: foto de perfil del cliente (Facebook/Instagram). Solo se guarda una URL real de Meta,
-- nunca se pisa una que ya exista, y nunca cambia nada si no se manda foto.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-e111-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@av.test');
select t.as_user(:A); select t.save('org', public.create_organization('Avatar Test', 'avatar-test'));
select t.save('cust', (public.create_customer(t.id('org'), 'person', 'Contacto de Facebook 1234', '[{"type":"facebook","value":"1000001"}]'::jsonb, '{}'::jsonb) ->> 'customer_id')::uuid);
select t.reset();

insert into public.channels (org_id, kind, external_id, name, connection_status)
  select t.id('org'), 'facebook', '2000002', 'Página QA', 'connected';
insert into public.conversations (org_id, customer_id, channel_id, thread_key, contact_name)
  select t.id('org'), t.id('cust'), c.id, '1000001', null from public.channels c where c.external_id = '2000002';
select t.save('conv', (select id from public.conversations where customer_id = t.id('cust')));

-- ---- Una URL real de Meta sí se guarda
select t.as_service();
select public.set_contact_profile(t.id('conv'), 'Ana Gómez', 'https://scontent.fbcdn.net/v/foto.jpg');
select t.reset();
select t.ok('la foto se guardó', (select avatar_url = 'https://scontent.fbcdn.net/v/foto.jpg' from public.customers where id = t.id('cust')));

-- ---- No se pisa una que ya existe (por ejemplo, si Meta cambia la foto luego, no la seguimos actualizando sola)
select t.as_service();
select public.set_contact_profile(t.id('conv'), 'Ana Gómez', 'https://scontent.fbcdn.net/v/otra-foto.jpg');
select t.reset();
select t.ok('no se sobreescribe una foto que ya estaba guardada', (select avatar_url = 'https://scontent.fbcdn.net/v/foto.jpg' from public.customers where id = t.id('cust')));

-- ---- Una URL que no es de los dominios de Meta se ignora (nunca se guarda algo arbitrario)
select t.as_user(:A); select t.save('cust2', (public.create_customer(t.id('org'), 'person', 'Contacto de Instagram 5678', '[{"type":"instagram","value":"3000003"}]'::jsonb, '{}'::jsonb) ->> 'customer_id')::uuid); select t.reset();
insert into public.channels (org_id, kind, external_id, name, connection_status) select t.id('org'), 'instagram', '4000004', 'IG QA', 'connected';
insert into public.conversations (org_id, customer_id, channel_id, thread_key, contact_name) select t.id('org'), t.id('cust2'), c.id, '3000003', null from public.channels c where c.external_id = '4000004';
select t.save('conv2', (select id from public.conversations where customer_id = t.id('cust2')));
select t.as_service();
select public.set_contact_profile(t.id('conv2'), 'Beto López', 'https://malicioso.com/robar.jpg');
select t.reset();
select t.ok('una URL que no es de Meta se ignora silenciosamente (no revienta, no guarda nada)', (select avatar_url is null from public.customers where id = t.id('cust2')));

-- ---- Sin mandar foto (llamando con los 2 parámetros de siempre), no pasa nada raro
select t.as_user(:A); select t.save('cust3', (public.create_customer(t.id('org'), 'person', 'Contacto de Facebook 9999', '[{"type":"facebook","value":"5000005"}]'::jsonb, '{}'::jsonb) ->> 'customer_id')::uuid); select t.reset();
insert into public.channels (org_id, kind, external_id, name, connection_status) select t.id('org'), 'facebook', '6000006', 'Página QA 2', 'connected';
insert into public.conversations (org_id, customer_id, channel_id, thread_key, contact_name) select t.id('org'), t.id('cust3'), c.id, '5000005', null from public.channels c where c.external_id = '6000006';
select t.save('conv3', (select id from public.conversations where customer_id = t.id('cust3')));
select t.as_service();
select public.set_contact_profile(t.id('conv3'), 'Carla Ruiz');
select t.reset();
select t.ok('sin mandar foto, el nombre se actualiza igual y la foto queda vacía', (select full_name = 'Carla Ruiz' and avatar_url is null from public.customers where id = t.id('cust3')));

-- ---- Solo el servidor puede llamar esta función
select t.as_user(:A);
select t.throws('un usuario normal no puede llamar esta función directamente', format('select public.set_contact_profile(%L, ''Hackeado'', ''https://scontent.fbcdn.net/x.jpg'')', t.id('conv')), '42501');
select t.reset();

rollback;
\echo ✔ FOTO DE PERFIL: TODAS LAS PRUEBAS PASARON
