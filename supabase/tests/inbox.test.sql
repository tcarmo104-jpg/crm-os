-- Pruebas del inbox (WhatsApp): identidad, deduplicación, ventana de 24 h, «no contactar», estados, secretos, visibilidad.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set S1 '''51000000-0000-0000-0000-000000000001'''
\set S2 '''52000000-0000-0000-0000-000000000002'''
\set M  '''4d000000-0000-0000-0000-00000000000d'''
\set E  '''e0000000-0000-0000-0000-00000000000e'''
\set V  '''56000000-0000-0000-0000-000000000006'''
\set CS '''c5000000-0000-0000-0000-0000000000c5'''
\set T1 '''11111111-0000-0000-0000-000000000001'''
\set T2 '''22222222-0000-0000-0000-000000000002'''
\set PID '''109876543210'''
\set TOKEN '''EAAB-token-abcdefghijklmnopqrstuvwxyz'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values
  (:A, 'a@acme.test'), (:B, 'b@beta.test'), (:S1, 's1@acme.test'), (:S2, 's2@acme.test'),
  (:M, 'm@acme.test'), (:E, 'e@acme.test'), (:V, 'v@acme.test'), (:CS, 'cs@acme.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('S2', :S2), ('M', :M), ('E', :E), ('V', :V), ('CS', :CS), ('T1', :T1), ('T2', :T2);

select t.as_user(:A); select t.save('orgA', public.create_organization('Acme', 'acme'));
insert into public.teams (id, org_id, name) values (:T1, t.id('orgA'), 'Bogotá'), (:T2, t.id('orgA'), 'Medellín');
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), u.uid, r.id, u.team
    from (values (:S1::uuid, 'sales_agent', :T1::uuid), (:S2::uuid, 'sales_agent', :T2::uuid), (:M::uuid, 'manager', null::uuid),
                 (:E::uuid, 'sales_manager', :T1::uuid), (:V::uuid, 'viewer', null::uuid), (:CS::uuid, 'customer_service', null::uuid)) u(uid, rk, team)
    join public.roles r on r.key = u.rk and r.org_id is null;
select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Beta', 'beta')); select t.reset();

-- ---------------------------------------------------------------------------
-- Canales y secretos
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.throws('un vendedor no crea canales', format('select public.create_channel(%L, ''X'', ''111111111'')', t.id('orgA')), '42501');
select t.reset();
select t.as_user(:A);
select t.save('ch', public.create_channel(t.id('orgA'), 'Ventas', :PID, '+57 300 000 0000', :TOKEN));
select t.throws('el id de teléfono debe ser numérico', format('select public.create_channel(%L, ''X'', ''abc'')', t.id('orgA')), '23514');
select t.throws('las llaves cortas se rechazan', format('select public.save_channel_token(%L, ''corto'')', t.id('ch')), '23514');
select t.reset();
select t.as_user(:B);
select t.throws('el mismo número no puede registrarse en otra organización (el webhook se enruta por él)',
  format('select public.create_channel(%L, ''Copia'', %L)', t.id('orgB'), :PID), '23505');
select t.ok('otra organización no ve el canal', (select count(*) from public.channels) = 0);
select t.reset();

select t.as_user(:A);
select t.throws('NI el administrador puede leer los tokens (tabla sin acceso)', 'select access_token from public.channel_secrets', '42501');
select t.throws('ni ejecutar la función que los entrega', format('select public.channel_credentials(%L)', t.id('ch')), '42501');
select t.reset();
select t.as_service();
select t.ok('solo el servidor lee el token', public.channel_credentials(t.id('ch')) = :TOKEN);
select t.reset();
select t.as_user(:S1);
select t.throws('un vendedor no cambia tokens', format('select public.save_channel_token(%L, %L)', t.id('ch'), 'EAAB-otro-token-abcdefghijklmnopqrstuvwxyz'), '42501');
select t.throws('ni pausa canales', format('select public.set_channel_status(%L, ''paused'')', t.id('ch')), '42501');
select t.ok('pero sí ve que existe el canal (sin datos secretos)', (select count(*) from public.channels) = 1);
select t.reset();
select t.as_user(:A);
select public.save_channel_token(t.id('ch'), 'EAAB-rotado-abcdefghijklmnopqrstuvwxyz1');
select t.reset();
select t.ok('rotar el token lo reemplaza y el evento NO lo contiene',
  (select access_token = 'EAAB-rotado-abcdefghijklmnopqrstuvwxyz1' from public.channel_secrets where channel_id = t.id('ch'))
  and not exists (select 1 from public.domain_events where type like 'channel.%' and payload::text like '%EAAB%')
  and not exists (select 1 from public.audit_logs where entity_type = 'channels' and coalesce(new_values::text, '') || coalesce(old_values::text, '') like '%EAAB%'));
select t.as_user(:V); select t.ok('un viewer no ve canales', (select count(*) from public.channels) = 0); select t.reset();
select t.as_user(:A);
select t.ok('el administrador ve SI hay token, nunca cuál', (select bool_and(has_token) from public.channel_token_status(t.id('orgA'))));
select t.reset();
select t.as_user(:S1); select t.throws('un vendedor no consulta el estado de tokens', format('select * from public.channel_token_status(%L)', t.id('orgA')), '42501'); select t.reset();

-- Plantillas
select t.as_user(:A);
insert into public.message_templates (org_id, channel_id, name, language, body)
  values (t.id('orgA'), t.id('ch'), 'seguimiento', 'es', 'Hola {{1}}, seguimos con tu pedido {{2}}');
insert into public.message_templates (org_id, channel_id, name, language, body)
  values (t.id('orgA'), t.id('ch'), 'saludo', 'es', 'Gracias por escribirnos');
select t.save('tpl', (select id from public.message_templates where name = 'seguimiento'));
select t.save('tpl0', (select id from public.message_templates where name = 'saludo'));
select t.throws('los marcadores deben ser {{1}}, {{2}}… sin saltos', format('insert into public.message_templates (org_id, channel_id, name, language, body) values (%L, %L, ''mal'', ''es'', ''{{1}} y {{3}}'')', t.id('orgA'), t.id('ch')), '23514');
select t.throws('nombre de plantilla inválido', format('insert into public.message_templates (org_id, channel_id, name, language, body) values (%L, %L, ''Mal Nombre'', ''es'', ''x'')', t.id('orgA'), t.id('ch')), '23514');
select t.throws('idioma inválido', format('insert into public.message_templates (org_id, channel_id, name, language, body) values (%L, %L, ''ok'', ''ES'', ''x'')', t.id('orgA'), t.id('ch')), '23514');
select t.throws('nombre+idioma únicos por canal', format('insert into public.message_templates (org_id, channel_id, name, language, body) values (%L, %L, ''seguimiento'', ''es'', ''x'')', t.id('orgA'), t.id('ch')), '23505');
select t.reset();
select t.ok('el número de parámetros se calcula solo', (select param_count = 2 from public.message_templates where id = t.id('tpl')) and (select param_count = 0 from public.message_templates where id = t.id('tpl0')));
select t.as_user(:S1);
select t.ok('un vendedor ve las plantillas', (select count(*) from public.message_templates) = 2);
select t.throws('pero no las crea', format('insert into public.message_templates (org_id, channel_id, name, language, body) values (%L, %L, ''hack'', ''es'', ''x'')', t.id('orgA'), t.id('ch')), '42501');
select t.reset();
select t.as_user(:V); select t.ok('un viewer no ve plantillas', (select count(*) from public.message_templates) = 0); select t.reset();

-- ---------------------------------------------------------------------------
-- Un cliente existente (Carlos, de S1) y entradas
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('carlos', (public.create_customer(t.id('orgA'), 'person', 'Carlos Rodríguez', '[{"type":"phone","value":"+573001112233"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();

select t.as_service();
select t.ok('un canal desconocido no revienta: se informa y se ignora',
  public.ingest_whatsapp_message('999999999', '573001112233', 'X', 'wamid.X', 'text', 'hola', now()) ->> 'reason' = 'unknown_channel');
select t.throws('hilo inválido', format('select public.ingest_whatsapp_message(%L, ''abc'', ''X'', ''wamid.Y'', ''text'', ''hola'', now())', :PID), '22023');
select t.throws('id externo vacío', format('select public.ingest_whatsapp_message(%L, ''573001112233'', ''X'', '' '', ''text'', ''hola'', now())', :PID), '22023');

-- Contacto NUEVO
select t.ok('un contacto desconocido crea cliente, lead y conversación',
  (public.ingest_whatsapp_message(:PID, '573101112233', 'Laura Gómez', 'wamid.L1', 'text', 'Hola, ¿tienen sillas?', now() - interval '1 minute') ->> 'new_conversation')::boolean);
select t.reset();
select t.ok('cliente creado con el nombre del perfil y su teléfono en formato internacional',
  (select c.full_name = 'Laura Gómez' and c.owner_id is null from public.customers c join public.customer_identifiers i on i.customer_id = c.id where i.type = 'phone' and i.value = '+573101112233'));
select t.ok('lead con origen whatsapp, resolución «created», sin dueño',
  (select l.source = 'whatsapp' and l.resolution = 'created' and l.owner_id is null from public.leads l join public.customer_identifiers i on i.customer_id = l.customer_id where i.value = '+573101112233'));
select t.save('laura', (select customer_id from public.customer_identifiers where value = '+573101112233'));
select t.save('conv_l', (select id from public.conversations where thread_key = '573101112233'));
select t.ok('conversación abierta, sin leer, esperando respuesta, con vista previa',
  (select status = 'open' and unread and needs_reply and last_direction = 'inbound' and last_message_preview = 'Hola, ¿tienen sillas?'
      and contact_name = 'Laura Gómez' and owner_id is null from public.conversations where id = t.id('conv_l')));
select t.ok('se emite «conversación abierta» en la línea de tiempo del cliente',
  (select count(*) = 1 from public.domain_events where type = 'conversation.opened' and customer_id = t.id('laura')));

select t.as_service();
select t.ok('el mismo mensaje entregado dos veces (reintento de Meta) NO se duplica',
  (public.ingest_whatsapp_message(:PID, '573101112233', 'Laura Gómez', 'wamid.L1', 'text', 'Hola, ¿tienen sillas?', now()) ->> 'deduplicated')::boolean);
select public.ingest_whatsapp_message(:PID, '573101112233', 'Laura Gómez', 'wamid.L2', 'text', 'Necesito 4', now());
select t.reset();
select t.ok('el segundo mensaje se anexa a la misma conversación (1 cliente, 1 lead, 1 conversación, 2 mensajes)',
  (select count(*) = 2 from public.messages where conversation_id = t.id('conv_l'))
  and (select count(*) = 1 from public.conversations where thread_key = '573101112233')
  and (select count(*) = 1 from public.leads where customer_id = t.id('laura'))
  and (select last_message_preview = 'Necesito 4' from public.conversations where id = t.id('conv_l')));

select t.as_service();
select public.ingest_whatsapp_message(:PID, '573101112233', null, 'wamid.L0', 'text', 'mensaje viejo que llega tarde', now() - interval '10 minutes');
select t.reset();
select t.ok('un mensaje ATRASADO se guarda pero no pisa la vista previa ni la última fecha',
  (select last_message_preview = 'Necesito 4' from public.conversations where id = t.id('conv_l'))
  and (select count(*) = 3 from public.messages where conversation_id = t.id('conv_l')));

select t.as_service();
select public.ingest_whatsapp_message(:PID, '573101112233', null, 'wamid.LF', 'media', '[Imagen]', now() + interval '2 days', '{"type":"image","media_id":"123"}');
select public.ingest_whatsapp_message(:PID, '573101112233', null, 'wamid.LE', 'text', '   ', now());
select t.reset();
select t.ok('una fecha en el futuro se recorta a «ahora»', (select max(occurred_at) <= clock_timestamp() from public.messages where conversation_id = t.id('conv_l')));
select t.ok('un adjunto queda como «media» con su referencia; un mensaje vacío queda marcado',
  (select kind = 'media' and meta ->> 'media_id' = '123' from public.messages where external_id = 'wamid.LF')
  and (select body = '[Mensaje vacío]' from public.messages where external_id = 'wamid.LE'));

-- Cliente EXISTENTE
select t.as_service();
select t.ok('un cliente existente NO se duplica: se enlaza por su teléfono',
  (public.ingest_whatsapp_message(:PID, '573001112233', 'Carlos R.', 'wamid.C1', 'text', 'Buenas tardes', now()) ->> 'customer_id')::uuid = t.id('carlos'));
select t.reset();
select t.save('conv_c', (select id from public.conversations where thread_key = '573001112233'));
select t.ok('la conversación hereda dueño y equipo del cliente; el lead es «matched»; no hay clientes duplicados',
  (select owner_id = :S1 and team_id = :T1 and customer_id = t.id('carlos') from public.conversations where id = t.id('conv_c'))
  and (select count(*) = 1 from public.leads where customer_id = t.id('carlos') and source = 'whatsapp' and resolution = 'matched')
  and (select count(*) = 1 from public.customers where full_name = 'Carlos Rodríguez'));

-- ---------------------------------------------------------------------------
-- Visibilidad
-- ---------------------------------------------------------------------------
select t.as_user(:S1); select t.ok('S1 ve solo la conversación de su cliente', (select count(*) = 1 and bool_and(id = t.id('conv_c')) from public.conversations) and (select count(*) = 1 from public.messages)); select t.reset();
select t.as_user(:S2); select t.ok('S2 no ve nada (ni mensajes)', (select count(*) from public.conversations) = 0 and (select count(*) from public.messages) = 0); select t.reset();
select t.as_user(:M);  select t.ok('el manager ve todas, incluida la sin asignar', (select count(*) from public.conversations) = 2 and (select count(*) from public.messages) = 6); select t.reset();
select t.as_user(:E);  select t.ok('el sales manager ve la de su equipo, no la sin asignar', (select count(*) = 1 from public.conversations)); select t.reset();
select t.as_user(:CS); select t.ok('servicio al cliente no ve conversaciones ajenas', (select count(*) from public.conversations) = 0); select t.reset();
select t.as_user(:V);  select t.ok('un viewer no ve conversaciones', (select count(*) from public.conversations) = 0); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no', (select count(*) from public.conversations) = 0 and (select count(*) from public.messages) = 0); select t.reset();

select t.as_user(:M);
select t.ok('el manager asigna a Laura a S2', t.affected($q$update public.customers set owner_id = {S2} where id = {laura}$q$) = 1);
select t.reset();
select t.ok('las conversaciones siguen al cliente reasignado', (select owner_id = :S2 from public.conversations where id = t.id('conv_l')));
select t.as_user(:S2); select t.ok('S2 ahora ve la conversación de Laura', (select count(*) = 1 from public.conversations)); select t.reset();

-- ---------------------------------------------------------------------------
-- Enviar: permisos, ventana de 24 h, plantillas
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('m1', public.queue_message(t.id('conv_c'), '  Hola Carlos, ¿en qué te ayudo?  '));
select t.throws('un mensaje vacío', format('select public.queue_message(%L, ''   '')', t.id('conv_c')), '22023');
select t.throws('un mensaje de más de 4096 caracteres', format('select public.queue_message(%L, repeat(''x'', 4097))', t.id('conv_c')), '22023');
select t.reset();
select t.ok('el mensaje nace encolado, con su autor y sin espacios sobrantes',
  (select status = 'queued' and body = 'Hola Carlos, ¿en qué te ayudo?' and sent_by = :S1 and direction = 'outbound' and attempts = 0 from public.messages where id = t.id('m1')));
select t.ok('la conversación ya no espera respuesta', (select not needs_reply and last_direction = 'outbound' and last_message_preview like 'Hola Carlos%' from public.conversations where id = t.id('conv_c')));
select t.as_user(:S2); select t.throws('S2 no puede escribirle al cliente de S1', format('select public.queue_message(%L, ''hola'')', t.id('conv_c')), '42501'); select t.reset();
select t.as_user(:V);  select t.throws('un viewer no puede enviar', format('select public.queue_message(%L, ''hola'')', t.id('conv_c')), '42501'); select t.reset();
select t.as_user(:CS); select t.throws('ni servicio al cliente sobre conversaciones ajenas', format('select public.queue_message(%L, ''hola'')', t.id('conv_c')), '42501'); select t.reset();
select t.as_user(:S1);
select t.throws('no se puede escribir directamente en messages', format('insert into public.messages (org_id, channel_id, conversation_id, direction, body, status, occurred_at) values (%L, %L, %L, ''outbound'', ''x'', ''sent'', now())', t.id('orgA'), t.id('ch'), t.id('conv_c')), '42501');
select t.throws('ni modificar conversaciones', format('update public.conversations set status = ''closed'' where id = %L', t.id('conv_c')), '42501');
select t.reset();

-- Ventana de 24 h
update public.conversations set last_inbound_at = now() - interval '25 hours' where id = t.id('conv_c');
select t.as_user(:S1);
select t.throws('FUERA de las 24 h no se envía texto libre', format('select public.queue_message(%L, ''¿sigues ahí?'')', t.id('conv_c')), '23514');
select t.save('m_tpl', public.queue_template_message(t.id('conv_c'), t.id('tpl'), array['Carlos', E'A-100']));
select t.throws('la plantilla exige TODOS sus parámetros', format('select public.queue_template_message(%L, %L, array[''Carlos''])', t.id('conv_c'), t.id('tpl')), '22023');
select t.throws('y ninguno vacío', format('select public.queue_template_message(%L, %L, array[''Carlos'', ''  ''])', t.id('conv_c'), t.id('tpl')), '22023');
select t.save('m_tpl2', public.queue_template_message(t.id('conv_c'), t.id('tpl'), array[E'Car\nlos', 'A-101']));
select t.reset();
select t.ok('la plantilla se rellena y queda registrada como tal',
  (select kind = 'template' and body = 'Hola Carlos, seguimos con tu pedido A-100' and template_params = '["Carlos", "A-100"]'::jsonb and status = 'queued' from public.messages where id = t.id('m_tpl')));
select t.ok('saltos de línea en un parámetro se limpian (Meta los rechaza)', (select body = 'Hola Car los, seguimos con tu pedido A-101' from public.messages where id = t.id('m_tpl2')));
update public.message_templates set status = 'disabled' where id = t.id('tpl');
select t.as_user(:S1); select t.throws('una plantilla desactivada no se envía', format('select public.queue_template_message(%L, %L, array[''a'', ''b''])', t.id('conv_c'), t.id('tpl')), '22023'); select t.reset();
update public.message_templates set status = 'approved' where id = t.id('tpl');
update public.conversations set last_inbound_at = now() where id = t.id('conv_c');

-- Canal pausado
select t.as_user(:A); select public.set_channel_status(t.id('ch'), 'paused'); select t.reset();
select t.as_user(:S1); select t.throws('con el canal en pausa no se envía', format('select public.queue_message(%L, ''hola'')', t.id('conv_c')), '23514'); select t.reset();
select t.as_service(); select t.ok('pero los mensajes ENTRANTES se siguen guardando', (public.ingest_whatsapp_message(:PID, '573001112233', null, 'wamid.C2', 'text', 'sigo aquí', now()) ->> 'ok')::boolean); select t.reset();
select t.as_user(:A); select public.set_channel_status(t.id('ch'), 'active'); select t.reset();

-- ---------------------------------------------------------------------------
-- «No contactar» y bajas
-- ---------------------------------------------------------------------------
select t.as_user(:M); select t.ok('el manager marca a Carlos «no contactar»', t.affected($q$update public.customers set do_not_contact = true, dnc_reason = 'Pidió baja por teléfono' where id = {carlos}$q$) = 1); select t.reset();
select t.as_user(:S1);
select t.save('m_reply', public.queue_message(t.id('conv_c'), 'Claro, ya te ayudo con eso'));
select t.throws('a un cliente «no contactar» NO se le envían plantillas, ni dentro de la ventana', format('select public.queue_template_message(%L, %L, array[''a'', ''b''])', t.id('conv_c'), t.id('tpl')), '23514');
select t.reset();
select t.ok('...pero SÍ se le puede RESPONDER dentro de las 24 h a lo que él acaba de escribir', (select status = 'queued' from public.messages where id = t.id('m_reply')));
update public.conversations set last_inbound_at = now() - interval '30 hours' where id = t.id('conv_c');
select t.as_user(:S1); select t.throws('fuera de la ventana queda bloqueado por «no contactar»', format('select public.queue_message(%L, ''hola de nuevo'')', t.id('conv_c')), '23514'); select t.reset();

-- Baja pedida por el cliente: mensaje EXACTO
select t.as_service();
select public.ingest_whatsapp_message(:PID, '573101112233', null, 'wamid.NB', 'text', 'no me des de baja el pedido, gracias', now());
select t.reset();
select t.ok('una frase que contiene «baja» NO es una baja', (select not do_not_contact from public.customers where id = t.id('laura')));
select t.as_service();
select t.ok('«¡STOP!» sí lo es', (public.ingest_whatsapp_message(:PID, '573101112233', null, 'wamid.OPT', 'text', '¡STOP!', now()) ->> 'opt_out')::boolean);
select t.reset();
select t.ok('el cliente queda «no contactar» con el motivo, el mensaje marcado y el evento emitido',
  (select do_not_contact and dnc_reason = 'Pidió la baja por WhatsApp' from public.customers where id = t.id('laura'))
  and (select meta ->> 'opt_out' = 'true' from public.messages where external_id = 'wamid.OPT')
  and (select count(*) = 1 from public.domain_events where type = 'customer.dnc_set' and customer_id = t.id('laura')));
select t.as_user(:S2);
select t.ok('a Laura aún se le puede responder (acaba de escribir)', public.queue_message(t.id('conv_l'), 'Listo, no te escribiremos más') is not null);
select t.reset();

-- ---------------------------------------------------------------------------
-- Reclamo, resultado y estados
-- ---------------------------------------------------------------------------
select t.as_service();
select t.ok('el servidor reclama el mensaje y recibe todo lo necesario para enviarlo',
  (public.claim_outbound(t.id('m1')) ->> 'to') = '573001112233' and true);
select t.ok('un segundo reclamo del MISMO mensaje no obtiene nada (no se envía dos veces)', public.claim_outbound(t.id('m1')) is null);
select t.reset();
select t.ok('pasó a «enviando» con un intento', (select status = 'sending' and attempts = 1 from public.messages where id = t.id('m1')));
select t.as_service(); select public.finish_outbound(t.id('m1'), true, 'wamid.OUT1'); select t.reset();
select t.ok('enviado, con el id de Meta', (select status = 'sent' and external_id = 'wamid.OUT1' from public.messages where id = t.id('m1')));

select t.as_service();
select t.ok('«entregado» avanza', (public.apply_message_status(:PID, 'wamid.OUT1', 'delivered', now()) ->> 'applied')::boolean);
select t.ok('un «enviado» atrasado NO retrocede el estado', not (public.apply_message_status(:PID, 'wamid.OUT1', 'sent', now()) ->> 'applied')::boolean);
select t.ok('«leído» avanza', (public.apply_message_status(:PID, 'wamid.OUT1', 'read', now()) ->> 'applied')::boolean);
select t.ok('un «entregado» posterior a «leído» se ignora', not (public.apply_message_status(:PID, 'wamid.OUT1', 'delivered', now()) ->> 'applied')::boolean);
select t.ok('un «falló» tardío no borra un mensaje ya leído', not (public.apply_message_status(:PID, 'wamid.OUT1', 'failed', now(), '131026', 'x') ->> 'applied')::boolean);
select t.ok('un mensaje desconocido se informa (se reintentará después)', public.apply_message_status(:PID, 'wamid.NOPE', 'sent') ->> 'reason' = 'unknown_message');
select t.ok('un estado que no manejamos se ignora sin error', public.apply_message_status(:PID, 'wamid.OUT1', 'deleted') ->> 'reason' = 'ignored_status');
select t.reset();
select t.ok('el mensaje quedó en «leído»', (select status = 'read' from public.messages where id = t.id('m1')));

select t.as_service();
select public.claim_outbound(t.id('m_tpl')); select public.finish_outbound(t.id('m_tpl'), true, 'wamid.OUT2');
select public.apply_message_status(:PID, 'wamid.OUT2', 'failed', now(), '131047', 'Re-engagement message');
select t.reset();
select t.ok('un envío que falla después de «enviado» queda «falló» con su código', (select status = 'failed' and error_code = '131047' from public.messages where id = t.id('m_tpl')));

select t.as_service();
select public.claim_outbound(t.id('m_tpl2'));
select public.finish_outbound(t.id('m_tpl2'), false, null, '131047', 'Fuera de la ventana de 24 horas');
select public.claim_outbound(t.id('m_reply'));
select t.reset();
update public.messages set status = 'delivered', external_id = 'wamid.OUT3' where id = t.id('m_reply');
select t.as_service(); select public.finish_outbound(t.id('m_reply'), true, 'wamid.OUT3'); select t.reset();
select t.ok('un fallo definitivo guarda el motivo; y un resultado tardío no pisa un «entregado» que ya llegó',
  (select status = 'failed' and error_code = '131047' from public.messages where id = t.id('m_tpl2'))
  and (select status = 'delivered' from public.messages where id = t.id('m_reply')));

-- ---------------------------------------------------------------------------
-- Barrido de pendientes
-- ---------------------------------------------------------------------------
update public.conversations set last_inbound_at = now() where id = t.id('conv_c');
select t.as_user(:S1);
select t.save('q_old', public.queue_message(t.id('conv_c'), 'encolado hace rato'));
select t.save('q_new', public.queue_message(t.id('conv_c'), 'recién encolado'));
select t.save('q_stuck', public.queue_message(t.id('conv_c'), 'se quedó enviando'));
select t.reset();
update public.messages set created_at = now() - interval '3 minutes' where id = t.id('q_old');
update public.messages set status = 'sending', created_at = now() - interval '10 minutes' where id = t.id('q_stuck');
select t.as_service();
select t.ok('el barrido devuelve SOLO los encolados viejos (y no los recientes)',
  (select (public.sweep_outbound() -> 'retry_ids') ? t.id('q_old')::text));
select t.reset();
select t.ok('...y el «enviando» atascado se marca FALLÓ (resultado desconocido) en lugar de reenviarse',
  (select status = 'failed' and error_code = 'unknown_outcome' from public.messages where id = t.id('q_stuck'))
  and (select status = 'queued' from public.messages where id = t.id('q_new')));

-- ---------------------------------------------------------------------------
-- Cola de webhooks
-- ---------------------------------------------------------------------------
select t.as_user(:A); select t.throws('nadie con sesión lee raw_events', 'select * from public.raw_events', '42501'); select t.reset();
select t.as_service();
select t.reset();
select public.record_raw_event('{"a":1}'::jsonb);
select t.ok('un evento recién guardado no se reclama antes de tiempo, y sí pasado el tiempo mínimo',
  (select count(*) = 0 from public.claim_raw_events(10, 60)) and (select count(*) = 1 from public.claim_raw_events(10, 0)));
select t.ok('reclamarlo cuenta el intento', (select attempts = 2 from public.raw_events order by id desc limit 1));
select public.finish_raw_event((select max(id) from public.raw_events), false, 'boom');
select t.ok('un fallo lo deja pendiente para reintentar', (select status = 'pending' and last_error = 'boom' from public.raw_events order by id desc limit 1));
update public.raw_events set attempts = 8 where id = (select max(id) from public.raw_events);
select public.finish_raw_event((select max(id) from public.raw_events), false, 'boom');
select t.ok('tras 8 intentos se da por fallido (no reintenta eternamente)', (select status = 'failed' from public.raw_events order by id desc limit 1));
select public.finish_raw_event(public.record_raw_event('{"b":2}'::jsonb), true);
update public.raw_events set processed_at = now() - interval '40 days' where status = 'processed';
select t.ok('lo procesado se purga tras el plazo', public.purge_raw_events(30) = 1);

-- Regresión: la hora de Meta va redondeada a segundos y con su reloj; una respuesta del cliente
-- «segundos antes» que nuestro envío NO puede tratarse como anterior.
select t.as_user(:S1); select public.queue_message(t.id('conv_c'), 'te respondo ahora mismo'); select t.reset();
select t.as_service(); select public.ingest_whatsapp_message(:PID, '573001112233', null, 'wamid.SKEW', 'text', 'gracias, ahí quedo atento', now() - interval '5 seconds'); select t.reset();
select t.ok('una respuesta con hora ligeramente anterior a nuestro envío SÍ deja la conversación pendiente de responder',
  (select needs_reply and last_direction = 'inbound' and last_message_preview = 'gracias, ahí quedo atento' from public.conversations where id = t.id('conv_c')));

-- ---------------------------------------------------------------------------
-- Solo-anexar y cierre / reapertura
-- ---------------------------------------------------------------------------
select t.throws('el texto de un mensaje no se modifica', format('update public.messages set body = ''otro'' where id = %L', t.id('m1')), '23514');
select t.throws('ni su dirección', format('update public.messages set direction = ''inbound'' where id = %L', t.id('m1')), '23514');
select t.throws('ni el id externo ya asignado', format('update public.messages set external_id = ''otro'' where id = %L', t.id('m1')), '23514');
select t.throws('los mensajes no se borran', format('delete from public.messages where id = %L', t.id('m1')), '42501');
select t.throws('ni se vacía la tabla', 'truncate public.messages', '42501');
select t.throws('un mensaje entrante no puede tener estado de envío', format('insert into public.messages (org_id, channel_id, conversation_id, direction, body, status, occurred_at) values (%L, %L, %L, ''inbound'', ''x'', ''sent'', now())', t.id('orgA'), t.id('ch'), t.id('conv_c')), '23514');
select t.throws('ni uno saliente el estado «recibido»', format('insert into public.messages (org_id, channel_id, conversation_id, direction, body, status, occurred_at) values (%L, %L, %L, ''outbound'', ''x'', ''received'', now())', t.id('orgA'), t.id('ch'), t.id('conv_c')), '23514');
select t.throws('el mismo id externo no se repite en un canal (índice único)', format('insert into public.messages (org_id, channel_id, conversation_id, direction, body, status, occurred_at, external_id) values (%L, %L, %L, ''inbound'', ''x'', ''received'', now(), ''wamid.C1'')', t.id('orgA'), t.id('ch'), t.id('conv_c')), '23505');
select t.throws('la identidad de la conversación no cambia', format('update public.conversations set thread_key = ''573000000000'' where id = %L', t.id('conv_c')), '23514');

select t.as_user(:S1);
select public.mark_conversation_read(t.id('conv_c'));
select public.set_conversation_status(t.id('conv_c'), 'closed');
select t.throws('estado inválido', format('select public.set_conversation_status(%L, ''archivada'')', t.id('conv_c')), '22023');
select t.reset();
select t.ok('cerrada: sin leer y sin pendiente de respuesta', (select status = 'closed' and not unread and not needs_reply from public.conversations where id = t.id('conv_c')));
select t.as_user(:S2); select t.throws('S2 no puede marcar leída ni cerrar la de S1', format('select public.mark_conversation_read(%L)', t.id('conv_c')), '42501'); select t.reset();
select t.as_user(:V); select t.throws('un viewer tampoco', format('select public.set_conversation_status(%L, ''open'')', t.id('conv_c')), '42501'); select t.reset();
select t.as_service(); select public.ingest_whatsapp_message(:PID, '573001112233', null, 'wamid.C9', 'text', 'una pregunta más', now()); select t.reset();
select t.ok('un mensaje nuevo REABRE la conversación y lo deja en la línea de tiempo',
  (select status = 'open' and unread and needs_reply from public.conversations where id = t.id('conv_c'))
  and (select count(*) = 1 from public.domain_events where type = 'conversation.reopened' and customer_id = t.id('carlos')));

-- ---------------------------------------------------------------------------
-- Fusión de clientes y estructura
-- ---------------------------------------------------------------------------
select t.as_user(:M);
select public.merge_customers(t.id('carlos'), t.id('laura'));
select t.reset();
select t.ok('la fusión mueve las conversaciones del cliente absorbido al principal',
  (select customer_id = t.id('carlos') from public.conversations where id = t.id('conv_l')));

select t.ok('todas las tablas de public tienen RLS',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('las funciones del servidor NO son ejecutables desde el navegador (usuarios ni anónimos)',
  not has_function_privilege('authenticated', 'public.ingest_whatsapp_message(text, text, text, text, text, text, timestamptz, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.ingest_whatsapp_message(text, text, text, text, text, text, timestamptz, jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_outbound(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.finish_outbound(uuid, boolean, text, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.apply_message_status(text, text, text, timestamptz, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.sweep_outbound(int, int)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_raw_events(int, int)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.channel_credentials(uuid)', 'EXECUTE'));
delete from public.organizations where id = t.id('orgA');
select t.ok('eliminar la organización elimina canales, tokens, conversaciones y mensajes (aunque sean solo-anexar)',
  (select count(*) from public.channels where org_id = t.id('orgA')) = 0
  and (select count(*) from public.messages where org_id = t.id('orgA')) = 0
  and (select count(*) from public.channel_secrets) = 0);

rollback;
\echo ✔ INBOX: TODAS LAS PRUEBAS PASARON
