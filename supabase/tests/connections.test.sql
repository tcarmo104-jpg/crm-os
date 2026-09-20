-- Pruebas de 0016: modelo de conexiones (estados, verificación, actividad, desconexión, registro técnico).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-8888-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-8888-0000-0000-00000000000b'''
\set S1 '''51000000-8888-0000-0000-000000000001'''
\set V  '''56000000-8888-0000-0000-000000000006'''
\set PID '''519876543210'''
\set TOKEN '''EAABxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values (:A, 'a@c.test'), (:B, 'b@c.test'), (:S1, 's1@c.test'), (:V, 'v@c.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('V', :V);

select t.as_user(:A); select t.save('orgA', public.create_organization('Conexiones A', 'conexiones-a')); select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Conexiones B', 'conexiones-b')); select t.reset();
insert into public.memberships (org_id, user_id, role_id)
  select t.id('orgA'), u.uid, r.id from (values (:S1::uuid, 'sales_agent'), (:V::uuid, 'viewer')) u(uid, rk) join public.roles r on r.key = u.rk and r.org_id is null;

select t.as_user(:A);
select t.save('ch', public.create_channel(t.id('orgA'), 'Ventas', :PID, '+57 300 000 0000', :TOKEN));
select t.reset();

-- Estado inicial
select t.ok('un número recién conectado nace «pendiente», sin fechas de sincronización ni error',
  (select connection_status = 'pending' and last_sync_at is null and last_webhook_at is null and last_error_code is null and metadata = '{}'::jsonb
     and business_account_id is null and disconnected_at is null from public.channels where id = t.id('ch')));

-- Verificación (solo el servidor)
select t.as_user(:A);
select t.throws('un administrador NO puede escribir el resultado de una verificación (solo el servidor)',
  format('select public.record_channel_health(%L, ''connected'')', t.id('ch')), '42501');
select t.throws('ni tocar la actividad', 'select public.touch_channel(''519876543210'', ''webhook'')', '42501');
select t.reset();

select t.as_service();
select public.record_channel_health(t.id('ch'), 'connected', null, 'Número verificado', 'Arkos Ventas', '+57 300 111 2233', '123456789012345', '{"quality_rating":"GREEN"}'::jsonb);
select t.reset();
select t.ok('«conectado»: guarda cuenta, nombre, WABA, calidad y las fechas',
  (select connection_status = 'connected' and account_name = 'Arkos Ventas' and display_phone = '+57 300 111 2233' and business_account_id = '123456789012345'
     and metadata ->> 'quality_rating' = 'GREEN' and connected_at is not null and last_sync_at is not null and last_checked_at is not null and last_error_code is null
     from public.channels where id = t.id('ch')));
select t.ok('el registro técnico anota la verificación', (select count(*) = 1 and bool_and(ok) and bool_and(kind = 'health_check') from public.connection_events where channel_id = t.id('ch')));
select t.ok('el cambio de estado queda en el flujo de eventos',
  (select count(*) = 1 from public.domain_events where type = 'channel.connection_changed' and payload ->> 'to' = 'connected'));

select t.as_service();
select t.throws('un estado inventado se rechaza', format('select public.record_channel_health(%L, ''genial'')', t.id('ch')), '22023');
select public.record_channel_health(t.id('ch'), 'token_expired', '190', 'Error validating access token: EAABxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx expired; Authorization: Bearer abc123secret');
select t.reset();
select t.ok('«token expirado»: guarda el código y conserva lo aprendido antes (nombre, WABA)',
  (select connection_status = 'token_expired' and last_error_code = '190' and account_name = 'Arkos Ventas' and business_account_id = '123456789012345' from public.channels where id = t.id('ch')));
select t.ok('el detalle técnico NUNCA conserva el token ni el encabezado de autorización',
  (select detail not like '%EAAB%' and detail not like '%abc123secret%' and detail like '%[token]%' from public.connection_events where channel_id = t.id('ch') and code = '190'));
select t.ok('...ni el flujo de eventos', not exists (select 1 from public.domain_events where payload::text like '%EAAB%'));

-- Actividad real
select t.as_service();
select public.touch_channel('519876543210', 'send_ok');
select t.reset();
select t.ok('un envío aceptado por Meta recupera una conexión con token expirado (es la prueba de que el token sirve)',
  (select connection_status = 'connected' and last_error_code is null from public.channels where id = t.id('ch')));
select t.as_service(); select public.record_channel_health(t.id('ch'), 'webhook_missing', 'no_webhook', 'Aún no llega ningún mensaje'); select t.reset();
select t.as_service(); select public.touch_channel('519876543210', 'send_ok'); select t.reset();
select t.ok('...pero un envío NO arregla un webhook que no llega', (select connection_status = 'webhook_missing' from public.channels where id = t.id('ch')));
select t.as_service(); select public.touch_channel('519876543210', 'webhook'); select t.reset();
select t.ok('un mensaje recibido SÍ prueba el webhook: «conectado» y se anota el último webhook',
  (select connection_status = 'connected' and last_webhook_at is not null and last_error_code is null from public.channels where id = t.id('ch')));
update public.channels set last_webhook_at = now() - interval '10 seconds' where id = t.id('ch');
create table t.stamp (v timestamptz);
insert into t.stamp select last_webhook_at from public.channels where id = t.id('ch');
select t.as_service(); select public.touch_channel('519876543210', 'webhook'); select t.reset();
select t.ok('la actividad se anota como máximo una vez por minuto (una de hace 10 s no se vuelve a escribir)',
  (select last_webhook_at = (select v from t.stamp) from public.channels where id = t.id('ch')));
update public.channels set last_webhook_at = now() - interval '5 minutes' where id = t.id('ch');
select t.as_service(); select public.touch_channel('519876543210', 'webhook'); select t.reset();
select t.ok('...pero una de hace 5 minutos sí', (select last_webhook_at > now() - interval '1 minute' from public.channels where id = t.id('ch')));
select t.as_service();
select public.record_channel_health(t.id('ch'), 'error', 'network', 'Sin respuesta de Meta');
select t.reset();
select t.ok('«error de conexión» guarda su código', (select connection_status = 'error' and last_error_code = 'network' from public.channels where id = t.id('ch')));
select t.as_service(); select public.record_channel_health(t.id('ch'), 'connected'); select t.reset();
select t.ok('al volver a «conectado» el código de error se limpia', (select connection_status = 'connected' and last_error_code is null from public.channels where id = t.id('ch')));
select t.as_service(); select t.throws('actividad de un tipo desconocido', 'select public.touch_channel(''519876543210'', ''otra'')', '22023'); select t.reset();

-- Conversación para probar el envío
select t.as_user(:S1);
select t.save('cust', (public.create_customer(t.id('orgA'), 'person', 'Cliente Conexión', '[{"type":"phone","value":"+573001110099"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_service(); select public.ingest_whatsapp_message(:PID, '573001110099', 'Cliente Conexión', 'c.1', 'text', 'hola', now()); select t.reset();
select t.save('conv', (select id from public.conversations where thread_key = '573001110099'));
select t.as_user(:S1); select public.queue_message(t.id('conv'), 'Hola, ¿en qué te ayudo?'); select t.reset();
select t.ok('con la conexión activa el vendedor puede responder', (select count(*) = 1 from public.messages where conversation_id = t.id('conv') and direction = 'outbound'));

-- Administradores y permisos
select t.as_user(:S1);
select t.throws('un vendedor no puede desconectar', format('select public.disconnect_channel(%L)', t.id('ch')), '42501');
select t.throws('ni indicar la cuenta de WhatsApp Business', format('select public.set_channel_business_account(%L, ''123456789012345'')', t.id('ch')), '42501');
select t.throws('ni guardar un token', format('select public.save_channel_token(%L, ''EAAB-otro'')', t.id('ch')), '42501');
select t.ok('ni ve el registro técnico', (select count(*) = 0 from public.connection_events));
select t.reset();
select t.as_user(:V);
select t.throws('un viewer tampoco desconecta', format('select public.disconnect_channel(%L)', t.id('ch')), '42501');
select t.reset();
select t.as_user(:B);
select t.throws('otra organización no toca esta conexión', format('select public.disconnect_channel(%L)', t.id('ch')), '42501');
select t.ok('ni ve su registro técnico', (select count(*) = 0 from public.connection_events));
select t.reset();
select t.as_user(:A);
select t.ok('el administrador SÍ ve el registro técnico', (select count(*) >= 3 from public.connection_events));
select t.throws('y no lo escribe directamente', format('insert into public.connection_events (org_id, channel_id, kind, ok) values (%L, %L, ''error'', false)', t.id('orgA'), t.id('ch')), '42501');
select public.set_channel_business_account(t.id('ch'), '999888777666555');
select t.throws('la cuenta de WhatsApp Business debe ser numérica', format('select public.set_channel_business_account(%L, ''abc'')', t.id('ch')), '23514');
select t.reset();
select t.ok('la cuenta de WhatsApp Business quedó guardada', (select business_account_id = '999888777666555' from public.channels where id = t.id('ch')));

-- Desconexión
select t.as_user(:A); select public.disconnect_channel(t.id('ch')); select public.disconnect_channel(t.id('ch')); select t.reset();
select t.ok('desconectar: estado, fecha y token borrado',
  (select connection_status = 'disconnected' and disconnected_at is not null from public.channels where id = t.id('ch'))
  and (select count(*) = 0 from public.channel_secrets where channel_id = t.id('ch')));
select t.ok('desconectar dos veces no duplica el registro', (select count(*) = 1 from public.connection_events where channel_id = t.id('ch') and kind = 'disconnected'));
select t.ok('CONSERVA todo el historial (conversación y mensajes)',
  (select count(*) = 1 from public.conversations where id = t.id('conv')) and (select count(*) = 2 from public.messages where conversation_id = t.id('conv')));
select t.as_user(:S1);
select t.throws('con el número desconectado ya no se puede responder', format('select public.queue_message(%L, ''Otra respuesta'')', t.id('conv')), '23514');
select t.ok('...pero el historial sigue visible', (select count(*) = 2 from public.messages where conversation_id = t.id('conv')));
select t.reset();
select t.as_service();
select public.record_channel_health(t.id('ch'), 'connected', null, 'verificación en vuelo');
select public.touch_channel('519876543210', 'send_ok');
select public.touch_channel('519876543210', 'webhook');
select t.reset();
select t.ok('una verificación o actividad en vuelo NO reconecta un número desconectado', (select connection_status = 'disconnected' from public.channels where id = t.id('ch')));

-- Reconexión
select t.as_user(:A); select public.save_channel_token(t.id('ch'), 'EAAB-token-nuevo-abcdefghijklmnopqrstuvwxyz'); select t.reset();
select t.ok('guardar un token nuevo reabre la conexión como «pendiente» (hay que verificarla)',
  (select connection_status = 'pending' and disconnected_at is null from public.channels where id = t.id('ch'))
  and (select count(*) = 1 from public.channel_secrets where channel_id = t.id('ch'))
  and (select count(*) = 1 from public.connection_events where channel_id = t.id('ch') and kind = 'reconnected'));
select t.as_user(:S1); select public.queue_message(t.id('conv'), 'Ya estamos de vuelta'); select t.reset();
select t.ok('y se vuelve a poder responder', (select count(*) = 3 from public.messages where conversation_id = t.id('conv')));

-- Límites
select t.throws('el metadato no puede crecer sin límite',
  format('select public.record_channel_health(%L, ''connected'', null, null, null, null, null, %L::jsonb)', t.id('ch'), jsonb_build_object('x', repeat('a', 5000))::text), '23514');
select app.connection_event(t.id('ch'), t.id('orgA'), 'error', false, 'x', 'evento ' || g, null) from generate_series(1, 130) g;
select t.ok('el registro técnico conserva solo los últimos 100 por conexión', (select count(*) = 100 from public.connection_events where channel_id = t.id('ch')));

-- Estructura
select t.ok('todas las tablas de public tienen RLS', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('las funciones del servidor no las ejecutan ni usuarios ni anónimos',
  not has_function_privilege('authenticated', 'public.record_channel_health(uuid, text, text, text, text, text, text, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.touch_channel(text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.connection_event(uuid, uuid, text, boolean, text, text, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.disconnect_channel(uuid)', 'EXECUTE'));

rollback;
\echo ✔ CONEXIONES: TODAS LAS PRUEBAS PASARON
