-- Pruebas de 0017: Facebook, Instagram y Gmail sobre el mismo modelo de canales/Inbox.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-a111-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-a111-0000-0000-00000000000b'''
\set S1 '''51000000-a111-0000-0000-000000000001'''
\set FB '''100000000000001'''
\set IG '''17841400000000001'''
\set GM '''ventas@arkos.co'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values (:A, 'a@m.test'), (:B, 'b@m.test'), (:S1, 's1@m.test');
select t.as_user(:A); select t.save('orgA', public.create_organization('Multi A', 'multi-a')); select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Multi B', 'multi-b')); select t.reset();
insert into public.memberships (org_id, user_id, role_id) select t.id('orgA'), :S1::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;

-- Formatos por proveedor
select t.throws('un proveedor desconocido no entra', format('insert into public.channels (org_id, kind, name, external_id) values (%L, ''tiktok'', ''x'', ''12345'')', t.id('orgA')), '23514');
select t.throws('una página de Facebook debe tener un ID numérico', format('insert into public.channels (org_id, kind, name, external_id) values (%L, ''facebook'', ''x'', ''mi-pagina'')', t.id('orgA')), '23514');
select t.throws('la cuenta de Gmail debe ser un correo', format('insert into public.channels (org_id, kind, name, external_id) values (%L, ''gmail'', ''x'', ''no-es-correo'')', t.id('orgA')), '23514');
select t.throws('...y en minúsculas', format('insert into public.channels (org_id, kind, name, external_id) values (%L, ''gmail'', ''x'', ''Ventas@Arkos.co'')', t.id('orgA')), '23514');

-- Conectar (administrador, tras autorizar en Meta/Google)
select t.as_user(:S1);
select t.throws('un vendedor no puede conectar cuentas', format('select public.connect_channel(%L, ''facebook'', ''Pág'', %L, null, ''Pág'', ''EAAB-page-token-ok-xyz-123'')', t.id('orgA'), :FB), '42501');
select t.reset();
select t.as_user(:A);
select t.save('fb', public.connect_channel(t.id('orgA'), 'facebook', 'Arkos Página', :FB, null, 'Arkos', 'EAAB-page-token-uno-xyz', '{"page_id":"100000000000001"}'::jsonb));
select t.save('ig', public.connect_channel(t.id('orgA'), 'instagram', 'Arkos IG', :IG, '@arkos', 'Arkos', 'EAAB-page-token-uno-xyz', '{"page_id":"100000000000001","username":"arkos"}'::jsonb));
select t.save('gm', public.connect_channel(t.id('orgA'), 'gmail', 'Ventas', 'Ventas@Arkos.co', null, 'Ventas Arkos', '1//refresh-token-uno-abcdef'));
select t.throws('WhatsApp se conecta por su propio camino', format('select public.connect_channel(%L, ''whatsapp'', ''x'', ''12345678'', null, null, ''tok-tok-tok-tok-tok-tok'')', t.id('orgA')), '22023');
select t.throws('sin token no se conecta', format('select public.connect_channel(%L, ''facebook'', ''x'', ''100000000000009'', null, null, ''   '')', t.id('orgA')), '22023');
select t.reset();
select t.ok('cada cuenta queda «pendiente» con su token, metadatos y el correo en minúsculas',
  (select count(*) = 3 and bool_and(connection_status = 'pending') from public.channels where org_id = t.id('orgA') and kind in ('facebook', 'instagram', 'gmail'))
  and (select external_id = 'ventas@arkos.co' from public.channels where id = t.id('gm'))
  and (select metadata ->> 'username' = 'arkos' and display_phone = '@arkos' from public.channels where id = t.id('ig'))
  and (select count(*) = 3 from public.channel_secrets where channel_id in (t.id('fb'), t.id('ig'), t.id('gm'))));
select t.ok('y se anota en el registro técnico (sin el token)',
  (select count(*) = 3 from public.connection_events where kind = 'connected') and not exists (select 1 from public.connection_events where detail like '%EAAB%'));
select t.as_user(:A);
select t.ok('conectar de nuevo la misma cuenta reutiliza la conexión y reemplaza el token', public.connect_channel(t.id('orgA'), 'facebook', 'Otro nombre', :FB, null, null, 'EAAB-page-token-dos-xyz') = t.id('fb'));
select t.reset();
select t.ok('...sin duplicar', (select count(*) = 1 from public.channels where kind = 'facebook' and external_id = '100000000000001')
  and (select access_token = 'EAAB-page-token-dos-xyz' from public.channel_secrets where channel_id = t.id('fb')));
select t.as_user(:B);
select t.throws('otra organización no puede apropiarse de una cuenta ya conectada', format('select public.connect_channel(%L, ''facebook'', ''x'', %L, null, null, ''tok-tok-tok-tok-tok-tok'')', t.id('orgB'), :FB), '23505');
select t.reset();

-- Sesiones OAuth
select t.as_service();
select t.save('sess', public.save_oauth_session(t.id('orgA'), :A, 'meta', '{"pages":[]}'));
select t.reset();
select t.as_service();
select t.ok('otro usuario u otra organización no pueden tomar la sesión', public.take_oauth_session(t.id('sess'), t.id('orgA'), :S1) is null and public.take_oauth_session(t.id('sess'), t.id('orgB'), :A) is null);
select t.ok('quien la inició la recibe UNA sola vez', public.take_oauth_session(t.id('sess'), t.id('orgA'), :A) = '{"pages":[]}' and public.take_oauth_session(t.id('sess'), t.id('orgA'), :A) is null);
select t.save('sess2', public.save_oauth_session(t.id('orgA'), :A, 'meta', '{"n":1}'));
select t.save('sess3', public.save_oauth_session(t.id('orgA'), :A, 'meta', '{"n":2}'));
select t.reset();
select t.ok('iniciar otra autorización descarta la anterior', (select count(*) = 1 from public.oauth_sessions where org_id = t.id('orgA')));
update public.oauth_sessions set expires_at = now() - interval '1 minute';
select t.as_service(); select t.ok('una sesión vencida no se entrega', public.take_oauth_session(t.id('sess3'), t.id('orgA'), :A) is null); select t.reset();
select t.as_user(:A); select t.throws('un usuario no puede leer las sesiones directamente', 'select count(*) from public.oauth_sessions', '42501'); select t.reset();

-- Recepción: Facebook
select t.as_service();
select t.save('fbmsg', (public.ingest_channel_message('facebook', :FB, '5500000000000001', null, 'mid.1', 'text', 'Hola, quiero cotizar un deck', now()) ->> 'conversation_id')::uuid);
select t.reset();
select t.ok('un contacto nuevo de Facebook crea cliente, lead y conversación (con nombre provisional)',
  (select count(*) = 1 from public.conversations where id = t.id('fbmsg') and channel_id = t.id('fb') and thread_key = '5500000000000001')
  and (select count(*) = 1 from public.customer_identifiers where type = 'facebook' and value = '5500000000000001')
  and (select count(*) = 1 from public.leads where source = 'facebook' and org_id = t.id('orgA'))
  and (select full_name = 'Contacto de Facebook 0001' from public.customers c join public.conversations v on v.customer_id = c.id where v.id = t.id('fbmsg')));
select t.as_service();
select public.ingest_channel_message('facebook', :FB, '5500000000000001', null, 'mid.2', 'text', 'Otra pregunta', now());
select t.ok('el mismo mensaje reenviado no se duplica', (public.ingest_channel_message('facebook', :FB, '5500000000000001', null, 'mid.2', 'text', 'Otra pregunta', now()) ->> 'deduplicated')::boolean);
select t.reset();
select t.ok('la misma persona escribiendo otra vez NO crea otro cliente, otro lead ni otra conversación',
  (select count(*) = 1 from public.conversations where channel_id = t.id('fb'))
  and (select count(*) = 1 from public.customers where full_name like 'Contacto de Facebook%')
  and (select count(*) = 1 from public.leads where source = 'facebook')
  and (select count(*) = 2 from public.messages where conversation_id = t.id('fbmsg')));
select t.as_service(); select public.set_contact_profile(t.id('fbmsg'), 'Ana Gómez'); select t.reset();
select t.ok('el perfil llega después y reemplaza el nombre provisional',
  (select full_name = 'Ana Gómez' from public.customers c join public.conversations v on v.customer_id = c.id where v.id = t.id('fbmsg'))
  and (select contact_name = 'Ana Gómez' from public.conversations where id = t.id('fbmsg')));
select t.as_service(); select public.set_contact_profile(t.id('fbmsg'), 'Otro Nombre'); select t.reset();
select t.ok('...pero un nombre real ya guardado no se pisa', (select full_name = 'Ana Gómez' from public.customers c join public.conversations v on v.customer_id = c.id where v.id = t.id('fbmsg')));

-- Recepción: Instagram (mismo número en otro canal = otra conversación) y validaciones
select t.as_service();
select t.save('igmsg', (public.ingest_channel_message('instagram', :IG, '5500000000000001', 'ana_gomez', 'mid.ig1', 'text', 'Hola desde Instagram', now()) ->> 'conversation_id')::uuid);
select t.reset();
select t.ok('Instagram crea su propia conversación con identificador «instagram» (y respeta el nombre que trae)',
  (select channel_id = t.id('ig') from public.conversations where id = t.id('igmsg'))
  and (select count(*) = 1 from public.customer_identifiers where type = 'instagram' and value = '5500000000000001')
  and (select count(*) = 1 from public.customers where full_name = 'ana_gomez'));
select t.as_service();
select t.throws('un identificador de contacto inválido se rechaza', format('select public.ingest_channel_message(''facebook'', %L, ''no-numerico'', null, ''mid.x'', ''text'', ''x'', now())', :FB), '22023');
select t.throws('WhatsApp no pasa por esta función', format('select public.ingest_channel_message(''whatsapp'', %L, ''5500000000000001'', null, ''mid.x'', ''text'', ''x'', now())', :FB), '22023');
select t.ok('una cuenta desconocida no falla: se ignora', (public.ingest_channel_message('facebook', '999999999999', '5500000000000001', null, 'mid.x', 'text', 'x', now()) ->> 'reason') = 'unknown_channel');
select t.reset();

-- Recepción: Gmail se asocia al cliente que YA existe por su correo
select t.as_user(:S1);
select t.save('cust', (public.create_customer(t.id('orgA'), 'person', 'Cliente Existente', '[{"type":"email","value":"cliente@ejemplo.com"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_service();
select t.save('gmmsg', (public.ingest_channel_message('gmail', 'ventas@arkos.co', 'Cliente@Ejemplo.com', 'Cliente Existente', 'gm.1', 'text', 'Necesito cotización de Wallpanel', now(), '{"message_id":"<abc@mail.gmail.com>","subject":"Cotización Wallpanel","gmail_thread_id":"t1"}'::jsonb) ->> 'conversation_id')::uuid);
select t.reset();
select t.ok('el correo de un cliente existente se une a ÉL: sin cliente nuevo',
  (select customer_id = t.id('cust') and thread_key = 'cliente@ejemplo.com' from public.conversations where id = t.id('gmmsg'))
  and (select count(*) = 1 from public.customers where org_id = t.id('orgA') and full_name = 'Cliente Existente'));
select t.as_service();
select t.save('gmnew', (public.ingest_channel_message('gmail', 'ventas@arkos.co', 'nuevo@empresa.com', 'Nuevo Contacto', 'gm.2', 'text', 'Hola', now()) ->> 'conversation_id')::uuid);
select t.reset();
select t.ok('un remitente desconocido crea el cliente con su correo (una vez)',
  (select count(*) = 1 from public.customer_identifiers where type = 'email' and value = 'nuevo@empresa.com')
  and (select full_name = 'Nuevo Contacto' from public.customers c join public.conversations v on v.customer_id = c.id where v.id = t.id('gmnew')));

-- Estado de mensajes enviados y datos para enviar
select t.as_user(:A);
select t.save('out1', public.queue_message(t.id('fbmsg'), 'Hola Ana, con gusto'));
select t.reset();
select t.as_service();
select t.ok('el envío sabe de qué proveedor es y a quién', (public.claim_outbound(t.id('out1')) ->> 'channel_kind') = 'facebook');
select public.finish_outbound(t.id('out1'), true, 'mid.out1');
select t.ok('se aplica «entregado» por proveedor', (public.apply_channel_status('facebook', :FB, 'mid.out1', 'delivered') ->> 'applied')::boolean);
select t.ok('...sin retroceder un estado', not (public.apply_channel_status('facebook', :FB, 'mid.out1', 'sent') ->> 'applied')::boolean);
select t.ok('un mensaje desconocido se avisa', (public.apply_channel_status('facebook', :FB, 'mid.nope', 'read') ->> 'reason') = 'unknown_message');
select t.reset();
select t.as_user(:A); select t.save('out2', public.queue_message(t.id('gmmsg'), 'Le enviamos la cotización')); select t.reset();
select t.as_service();
select t.ok('para Gmail el envío trae el mensaje al que se responde',
  (public.claim_outbound(t.id('out2')) -> 'reply_meta' ->> 'message_id') = '<abc@mail.gmail.com>' and (public.claim_outbound(t.id('out2')) is null));
select t.reset();

-- Ventanas de respuesta según el proveedor
update public.conversations set last_inbound_at = now() - interval '25 hours' where id in (t.id('fbmsg'), t.id('igmsg'));
select t.as_user(:A);
select t.throws('Facebook: pasadas 24 h no se puede escribir texto libre', format('select public.queue_message(%L, ''tarde'')', t.id('fbmsg')), '23514');
select t.throws('Instagram: igual', format('select public.queue_message(%L, ''tarde'')', t.id('igmsg')), '23514');
select t.reset();
update public.conversations set last_inbound_at = now() - interval '5 days' where id = t.id('gmmsg');
select t.as_user(:A);
select t.ok('Gmail: 5 días después todavía se puede responder', public.queue_message(t.id('gmmsg'), 'Seguimos atentos') is not null);
select t.reset();
update public.conversations set last_inbound_at = now() - interval '31 days' where id = t.id('gmmsg');
select t.as_user(:A);
select t.throws('Gmail: pasados 30 días no', format('select public.queue_message(%L, ''muy tarde'')', t.id('gmmsg')), '23514');
select t.reset();
insert into public.message_templates (org_id, channel_id, name, language, body, param_count, status) values (t.id('orgA'), t.id('fb'), 'saludo', 'es', 'Hola', 0, 'approved');
update public.conversations set last_inbound_at = now() where id = t.id('fbmsg');
select t.as_user(:A);
select t.throws('las plantillas son solo de WhatsApp', format('select public.queue_template_message(%L, (select id from public.message_templates where channel_id = %L limit 1), ''{}'')', t.id('fbmsg'), t.id('fb')), '22023');
select t.reset();

-- Actividad, metadatos y estado
update public.channels set connection_status = 'error', last_error_code = 'network' where id = t.id('gm');
select t.as_service();
select public.touch_channel('gmail', 'ventas@arkos.co', 'sync');
select public.touch_channel('facebook', :FB, 'webhook');
select public.merge_channel_metadata(t.id('gm'), '{"history_id":"12345"}'::jsonb);
select t.throws('actividad desconocida', format('select public.touch_channel(''gmail'', %L, ''otra'')', :GM), '22023');
select t.throws('proveedor desconocido', format('select public.touch_channel(''tiktok'', %L, ''sync'')', :GM), '22023');
select t.reset();
select t.ok('una sincronización correcta de Gmail recupera la conexión y anota la fecha',
  (select connection_status = 'connected' and last_sync_at is not null and last_error_code is null and metadata ->> 'history_id' = '12345' from public.channels where id = t.id('gm')));
select t.ok('un webhook de Facebook anota su último mensaje', (select last_webhook_at is not null from public.channels where id = t.id('fb')));

-- Desconexión: bloquea recepción y envío, conserva historial
select t.as_user(:A); select public.disconnect_channel(t.id('fb')); select t.reset();
select t.as_service();
select t.ok('un canal desconectado ya no recibe', (public.ingest_channel_message('facebook', :FB, '5500000000000009', null, 'mid.late', 'text', 'x', now()) ->> 'reason') = 'disconnected');
select public.merge_channel_metadata(t.id('fb'), '{"x":1}'::jsonb);
select t.reset();
select t.ok('...ni acepta metadatos nuevos', (select not (metadata ? 'x') from public.channels where id = t.id('fb')));
select t.as_user(:A);
select t.throws('...ni envía', format('select public.queue_message(%L, ''hola'')', t.id('fbmsg')), '23514');
select t.reset();
select t.ok('el historial de la conversación sigue', (select count(*) >= 2 from public.messages where conversation_id = t.id('fbmsg')));

-- Permisos
select t.ok('las funciones internas no las ejecuta ningún usuario ni anónimo',
  not has_function_privilege('authenticated', 'public.ingest_channel_message(text, text, text, text, text, text, text, timestamptz, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.take_oauth_session(uuid, uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.save_oauth_session(uuid, uuid, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.apply_channel_status(text, text, text, text, timestamptz, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.touch_channel(text, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.merge_channel_metadata(uuid, jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.set_contact_profile(uuid, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.connect_channel(uuid, text, text, text, text, text, text, jsonb)', 'EXECUTE'));
select t.ok('todas las tablas tienen RLS', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);

rollback;
\echo ✔ CANALES MULTI: TODAS LAS PRUEBAS PASARON
