-- Pruebas de 0014: etiquetas, respuestas rápidas y contador de no leídos.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-4444-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-4444-0000-0000-00000000000b'''
\set S1 '''51000000-4444-0000-0000-000000000001'''
\set S2 '''52000000-4444-0000-0000-000000000002'''
\set M  '''4d000000-4444-0000-0000-00000000000d'''
\set V  '''56000000-4444-0000-0000-000000000006'''
\set T1 '''11111111-4444-0000-0000-000000000001'''
\set T2 '''22222222-4444-0000-0000-000000000002'''
\set PID '''209876543210'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values (:A, 'a@x.test'), (:B, 'b@y.test'), (:S1, 's1@x.test'), (:S2, 's2@x.test'), (:M, 'm@x.test'), (:V, 'v@x.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('S2', :S2), ('M', :M), ('V', :V);

select t.as_user(:A); select t.save('orgA', public.create_organization('Acme4', 'acme4'));
insert into public.teams (id, org_id, name) values (:T1, t.id('orgA'), 'Norte'), (:T2, t.id('orgA'), 'Sur');
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), u.uid, r.id, u.team
    from (values (:S1::uuid, 'sales_agent', :T1::uuid), (:S2::uuid, 'sales_agent', :T2::uuid), (:M::uuid, 'manager', null::uuid), (:V::uuid, 'viewer', null::uuid)) u(uid, rk, team)
    join public.roles r on r.key = u.rk and r.org_id is null;
select t.save('ch', public.create_channel(t.id('orgA'), 'Ventas', :PID, null, 'EAAB-token-abcdefghijklmnopqrstuvwxyz'));
select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Beta4', 'beta4')); select t.reset();

select t.as_user(:S1);
select t.save('carlos', (public.create_customer(t.id('orgA'), 'person', 'Carlos Ruiz', '[{"type":"phone","value":"+573001110044"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_user(:M);
select t.save('x', (public.create_customer(t.id('orgA'), 'person', 'Cliente X', '[{"type":"phone","value":"+573001110045"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('y', (public.create_customer(t.id('orgA'), 'person', 'Cliente Y', '[{"type":"phone","value":"+573001110046"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();

-- ---------------------------------------------------------------------------
-- Etiquetas
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('leal', public.add_customer_tag(t.id('carlos'), 'Leal'));
select t.save('leal2', public.add_customer_tag(t.id('carlos'), '   leal  '));
select public.add_customer_tag(t.id('carlos'), 'Interesado', 'blue');
select t.throws('un nombre vacío', format('select public.add_customer_tag(%L, ''   '')', t.id('carlos')), '22023');
select t.throws('un nombre de más de 40 caracteres', format('select public.add_customer_tag(%L, repeat(''x'', 41))', t.id('carlos')), '22023');
select t.throws('un color que no existe', format('select public.add_customer_tag(%L, ''Otra'', ''fucsia'')', t.id('carlos')), '22023');
select t.reset();
select t.ok('«leal» con otras mayúsculas/espacios reutiliza la MISMA etiqueta (no duplica ni etiqueta ni vínculo)',
  t.id('leal') = t.id('leal2') and (select count(*) = 2 from public.tags where org_id = t.id('orgA')) and (select count(*) = 2 from public.customer_tags where customer_id = t.id('carlos')));
select t.ok('la etiqueta nueva recibe un color válido y el indicado se respeta',
  (select color in ('violet', 'blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink') from public.tags where id = t.id('leal'))
  and (select color = 'blue' from public.tags where name = 'Interesado'));
select t.throws('el índice único no admite dos etiquetas iguales (ni por mayúsculas)', format('insert into public.tags (org_id, name) values (%L, ''LEAL'')', t.id('orgA')), '23505');

select t.as_user(:S2); select t.throws('otro vendedor no etiqueta clientes ajenos', format('select public.add_customer_tag(%L, ''Intruso'')', t.id('carlos')), '42501'); select t.reset();
select t.as_user(:V);  select t.throws('un viewer no etiqueta', format('select public.add_customer_tag(%L, ''Intruso'')', t.id('carlos')), '42501'); select t.reset();
select t.as_user(:M);  select t.ok('el manager sí (alcance de organización)', public.add_customer_tag(t.id('carlos'), 'VIP') is not null); select t.reset();

select t.as_user(:S1); select t.ok('el dueño ve sus etiquetas y los vínculos', (select count(*) = 3 from public.customer_tags) and (select count(*) = 3 from public.tags)); select t.reset();
select t.as_user(:S2); select t.ok('otro vendedor NO ve los vínculos de un cliente que no es suyo', (select count(*) = 0 from public.customer_tags)); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no ve nada', (select count(*) = 0 from public.tags) and (select count(*) = 0 from public.customer_tags)); select t.reset();
select t.as_user(:V);  select t.ok('un viewer sin acceso a clientes tampoco ve vínculos', (select count(*) = 0 from public.customer_tags)); select t.reset();

select t.as_user(:S1);
select t.throws('no se escribe directamente en tags', format('insert into public.tags (org_id, name) values (%L, ''Directa'')', t.id('orgA')), '42501');
select t.throws('ni en customer_tags', format('insert into public.customer_tags (org_id, customer_id, tag_id) values (%L, %L, %L)', t.id('orgA'), t.id('carlos'), t.id('leal')), '42501');
select public.remove_customer_tag(t.id('carlos'), t.id('leal'));
select t.reset();
select t.ok('quitar la etiqueta borra el vínculo pero no la etiqueta', (select count(*) = 2 from public.customer_tags where customer_id = t.id('carlos')) and exists (select 1 from public.tags where id = t.id('leal')));
select t.as_user(:S2); select t.throws('otro vendedor no quita etiquetas ajenas', format('select public.remove_customer_tag(%L, %L)', t.id('carlos'), t.id('leal')), '42501'); select t.reset();

-- Fusión: etiquetas iguales en ambos clientes no chocan
select t.as_user(:M);
select public.add_customer_tag(t.id('x'), 'Común'); select public.add_customer_tag(t.id('x'), 'Solo X');
select public.add_customer_tag(t.id('y'), 'Común');
select public.merge_customers(t.id('y'), t.id('x'));
select t.reset();
select t.ok('la fusión une las etiquetas sin duplicar y sin error (Común una vez + Solo X)',
  (select count(*) = 2 from public.customer_tags where customer_id = t.id('y')) and (select count(*) = 0 from public.customer_tags where customer_id = t.id('x')));

-- ---------------------------------------------------------------------------
-- Respuestas rápidas
-- ---------------------------------------------------------------------------
select t.as_user(:S1); select t.save('qr1', public.create_quick_reply(t.id('orgA'), 'Saludo', '  Hola, ¿en qué te puedo ayudar?  ')); select t.reset();
select t.ok('el texto se guarda sin espacios sobrantes', (select body = 'Hola, ¿en qué te puedo ayudar?' from public.quick_replies where id = t.id('qr1')));
select t.as_user(:S1); select t.throws('título repetido (sin distinguir mayúsculas)', format('select public.create_quick_reply(%L, ''SALUDO'', ''otro'')', t.id('orgA')), '23505'); select t.reset();
select t.as_user(:S1); select t.throws('vacío', format('select public.create_quick_reply(%L, '' '', ''x'')', t.id('orgA')), '23514'); select t.reset();
select t.as_user(:V);  select t.throws('un viewer no crea respuestas rápidas', format('select public.create_quick_reply(%L, ''X'', ''y'')', t.id('orgA')), '42501'); select t.reset();
select t.as_user(:S2); select t.save('qr2', public.create_quick_reply(t.id('orgA'), 'Despedida', 'Gracias por escribirnos')); select t.reset();
select t.as_user(:S1); select t.ok('los vendedores comparten el catálogo de la organización', (select count(*) = 2 from public.quick_replies)); select t.reset();
select t.as_user(:V);  select t.ok('un viewer no las ve', (select count(*) = 0 from public.quick_replies)); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no', (select count(*) = 0 from public.quick_replies)); select t.reset();
select t.as_user(:S1); select t.throws('un vendedor no borra la de otro', format('select public.delete_quick_reply(%L)', t.id('qr2')), '42501'); select public.delete_quick_reply(t.id('qr1')); select public.delete_quick_reply(gen_random_uuid()); select t.reset();
select t.as_user(:A);  select public.delete_quick_reply(t.id('qr2')); select t.reset();
select t.ok('cada quien borra la suya; el administrador cualquiera; un id inexistente no falla', (select count(*) = 0 from public.quick_replies));

-- ---------------------------------------------------------------------------
-- Contador de no leídos
-- ---------------------------------------------------------------------------
select t.as_service();
select public.ingest_whatsapp_message(:PID, '573001110044', 'Carlos', 'w.1', 'text', 'uno', now());
select public.ingest_whatsapp_message(:PID, '573001110044', null, 'w.2', 'text', 'dos', now());
select public.ingest_whatsapp_message(:PID, '573001110044', null, 'w.3', 'text', 'tres', now());
select public.ingest_whatsapp_message(:PID, '573001110044', null, 'w.3', 'text', 'tres (reintento de Meta)', now());
select t.reset();
select t.save('conv', (select id from public.conversations where thread_key = '573001110044'));
select t.ok('3 mensajes entrantes = 3 sin leer; el reintento duplicado de Meta NO suma',
  (select unread and unread_count = 3 from public.conversations where id = t.id('conv')));
select t.as_user(:S1); select public.queue_message(t.id('conv'), 'Hola Carlos'); select t.reset();
select t.ok('al responder, el contador vuelve a 0', (select not unread and unread_count = 0 from public.conversations where id = t.id('conv')));
select t.as_service(); select public.ingest_whatsapp_message(:PID, '573001110044', null, 'w.4', 'text', 'cuatro', now()); select t.reset();
select t.ok('un mensaje nuevo empieza de nuevo en 1', (select unread and unread_count = 1 from public.conversations where id = t.id('conv')));
select t.as_user(:S1); select public.mark_conversation_read(t.id('conv')); select t.reset();
select t.ok('marcar como leída lo deja en 0', (select not unread and unread_count = 0 from public.conversations where id = t.id('conv')));
select t.as_service(); select public.ingest_whatsapp_message(:PID, '573001110044', null, 'w.5', 'text', 'cinco', now()); select public.ingest_whatsapp_message(:PID, '573001110044', null, 'w.6', 'text', 'seis', now()); select t.reset();
select t.as_user(:S1); select public.set_conversation_status(t.id('conv'), 'closed'); select t.reset();
select t.ok('cerrar la conversación lo deja en 0', (select not unread and unread_count = 0 from public.conversations where id = t.id('conv')));
select t.as_service(); select public.ingest_whatsapp_message(:PID, '573001110044', null, 'w.7', 'text', 'siete', now()); select t.reset();
select t.ok('al reabrirse por un mensaje nuevo cuenta desde 1', (select status = 'open' and unread_count = 1 from public.conversations where id = t.id('conv')));
select t.throws('el contador jamás es negativo', format('update public.conversations set unread_count = -1 where id = %L', t.id('conv')), '23514');

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select t.ok('todas las tablas de public tienen RLS', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('las funciones nuevas no son ejecutables por anónimos',
  not has_function_privilege('anon', 'public.add_customer_tag(uuid, text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_quick_reply(uuid, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.messages_count_unread()', 'EXECUTE'));
delete from public.organizations where id = t.id('orgA');
select t.ok('eliminar la organización elimina etiquetas y respuestas', (select count(*) from public.tags where org_id = t.id('orgA')) = 0 and (select count(*) from public.customer_tags) = 0);

rollback;
\echo ✔ INBOX CONTEXTO: TODAS LAS PRUEBAS PASARON
