-- Pruebas de 0018: adjuntos de mensajes (registro, visibilidad, cola de descarga, caducidad, permisos).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-c444-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-c444-0000-0000-00000000000b'''
\set S1 '''51000000-c444-0000-0000-000000000001'''
\set PID '''319876543210'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values (:A, 'a@at.test'), (:B, 'b@at.test'), (:S1, 's1@at.test');
select t.as_user(:A); select t.save('orgA', public.create_organization('Adj A', 'adj-a')); select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Adj B', 'adj-b')); select t.reset();
insert into public.memberships (org_id, user_id, role_id) select t.id('orgA'), :S1::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;

select t.as_user(:A); select t.save('ch', public.create_channel(t.id('orgA'), 'Ventas', :PID, '+57 300 000 0000', 'EAAB-token-abcdefghijklmnopqrstuvwxyz')); select t.reset();
-- dos clientes: uno del vendedor y otro del administrador (el vendedor NO ve el segundo)
select t.as_user(:S1); select public.create_customer(t.id('orgA'), 'person', 'Cliente del vendedor', '[{"type":"phone","value":"+573001110061"}]'::jsonb); select t.reset();
select t.as_user(:A); select public.create_customer(t.id('orgA'), 'person', 'Cliente del admin', '[{"type":"phone","value":"+573001110062"}]'::jsonb); select t.reset();
select t.as_service();
select public.ingest_whatsapp_message(:PID, '573001110061', 'Ana', 'wamid.a1', 'media', '[Imagen]', now(), '{"type":"image","media_id":"111","mime_type":"image/jpeg"}'::jsonb);
select public.ingest_whatsapp_message(:PID, '573001110062', 'Beto', 'wamid.b1', 'media', '[Documento: plano.pdf]', now(), '{"type":"document","media_id":"222"}'::jsonb);
select t.reset();
select t.save('m1', (select id from public.messages where external_id = 'wamid.a1'));
select t.save('m2', (select id from public.messages where external_id = 'wamid.b1'));

-- Registro (idempotente)
select t.as_service();
select t.ok('registra el adjunto de un mensaje: queda pendiente, en la conversación y organización correctas',
  public.register_message_attachments('whatsapp', :PID, 'wamid.a1', '[{"kind":"image","mime_type":"image/jpeg","source":{"media_id":"111"}}]'::jsonb) = 1);
select t.reset();
select t.ok('...con dirección, posición y estado esperados',
  (select count(*) = 1 and bool_and(status = 'pending' and position = 0 and direction = 'inbound' and org_id = t.id('orgA') and kind = 'image' and attempts = 0)
     from public.message_attachments where message_id = t.id('m1')));
select t.as_service();
select t.ok('llamarlo de nuevo (webhook reintentado) NO duplica', public.register_message_attachments('whatsapp', :PID, 'wamid.a1', '[{"kind":"image","source":{"media_id":"111"}}]'::jsonb) = 0);
select t.ok('un canal o mensaje desconocido no falla: devuelve 0',
  public.register_message_attachments('whatsapp', '999999999', 'wamid.a1', '[{"kind":"image"}]'::jsonb) = 0 and public.register_message_attachments('whatsapp', :PID, 'wamid.nope', '[{"kind":"image"}]'::jsonb) = 0);
select t.throws('items que no son una lista se rechazan', format('select public.register_message_attachments(''whatsapp'', %L, ''wamid.a1'', ''{"kind":"image"}'')', :PID), '22023');
select t.throws('más de 20 adjuntos se rechazan', format('select public.register_message_attachments(''whatsapp'', %L, ''wamid.a1'', (select jsonb_agg(jsonb_build_object(''kind'', ''file'')) from generate_series(1, 21)))', :PID), '22023');
select t.ok('varios adjuntos: posiciones 0..n-1; ubicación y contacto quedan «guardados» sin archivo; lo desconocido sin enlace, «no compatible»',
  public.register_message_attachments('whatsapp', :PID, 'wamid.b1',
    '[{"kind":"document","file_name":"plano.pdf","source":{"media_id":"222"}},{"kind":"location","meta":{"lat":6.2,"lng":-75.5}},{"kind":"contact","meta":{"name":"Carlos"}},{"kind":"unsupported"},{"kind":"video","source":{"url":"https://cdn.example/x"}},{"kind":"exe??"}]'::jsonb) = 6);
select t.reset();
select t.ok('...estados por tipo',
  (select array_agg(kind || ':' || status order by position) from public.message_attachments where message_id = t.id('m2'))
    = array['document:pending', 'location:stored', 'contact:stored', 'unsupported:unsupported', 'video:pending', 'unsupported:unsupported']);
select t.throws('un tipo inventado no entra a la tabla directamente', format('insert into public.message_attachments (org_id, message_id, conversation_id, direction, kind) values (%L, %L, (select conversation_id from public.messages where id = %L), ''inbound'', ''virus'')', t.id('orgA'), t.id('m1'), t.id('m1')), '23514');
select t.throws('el origen no puede crecer sin límite', format('insert into public.message_attachments (org_id, message_id, conversation_id, position, direction, kind, source) values (%L, %L, (select conversation_id from public.messages where id = %L), 30, ''inbound'', ''file'', %L::jsonb)', t.id('orgA'), t.id('m1'), t.id('m1'), jsonb_build_object('x', repeat('a', 3000))::text), '23514');

-- Visibilidad
select t.as_user(:S1);
select t.ok('el vendedor ve los adjuntos de SU conversación y NO los de la del administrador',
  (select count(*) = 1 from public.message_attachments where message_id = t.id('m1')) and (select count(*) = 0 from public.message_attachments where message_id = t.id('m2')));
select t.throws('nadie escribe adjuntos desde el navegador (insertar)', format('insert into public.message_attachments (org_id, message_id, conversation_id, direction, kind) values (%L, %L, (select conversation_id from public.messages where id = %L), ''inbound'', ''file'')', t.id('orgA'), t.id('m1'), t.id('m1')), '42501');
select t.throws('ni modificar', format('update public.message_attachments set status = ''stored'' where message_id = %L', t.id('m1')), '42501');
select t.throws('ni borrar', format('delete from public.message_attachments where message_id = %L', t.id('m1')), '42501');
select t.reset();
select t.as_user(:A); select t.ok('el administrador ve todos', (select count(*) = 7 from public.message_attachments)); select t.reset();
select t.as_user(:B); select t.ok('otra organización no ve ninguno', (select count(*) = 0 from public.message_attachments)); select t.reset();
select t.as_anon(); select t.throws('un anónimo ni siquiera consulta la tabla', 'select count(*) from public.message_attachments', '42501'); select t.reset();

-- Cola de descarga
select t.save('at1', (select id from public.message_attachments where message_id = t.id('m1')));
select t.as_service();
select t.ok('reclamar entrega los datos para descargar (canal, cuenta, origen)',
  (select (c ->> 'channel_kind') = 'whatsapp' and (c ->> 'account_id') = '319876543210' and (c -> 'source' ->> 'media_id') = '111' and (c ->> 'attempts') = '1' from (select public.claim_attachment(t.id('at1')) as c) x));
select t.ok('...y solo UN proceso lo consigue', public.claim_attachment(t.id('at1')) is null);
select t.reset();
select t.ok('el intento queda registrado', (select status = 'downloading' and attempts = 1 from public.message_attachments where id = t.id('at1')));
select t.as_service();
select t.throws('un estado inventado se rechaza', format('select public.finish_attachment(%L, ''genial'')', t.id('at1')), '22023');
select t.throws('«guardado» exige ruta y tamaño', format('select public.finish_attachment(%L, ''stored'')', t.id('at1')), '22023');
select public.finish_attachment(t.id('at1'), 'retry', p_error => 'network', p_retry_seconds => 120);
select t.ok('un fallo temporal lo devuelve a la cola, más tarde', (select status = 'pending' and next_attempt_at > now() + interval '100 seconds' and error_code = 'network' from public.message_attachments where id = t.id('at1')));
select t.ok('...y no se puede reclamar antes de tiempo', public.claim_attachment(t.id('at1')) is null);
select t.reset();
update public.message_attachments set next_attempt_at = now() - interval '1 second' where id = t.id('at1');
select t.as_service();
select t.ok('la cola lista lo que toca intentar', t.id('at1') in (select public.due_attachments(10)));
select public.claim_attachment(t.id('at1'));
select public.finish_attachment(t.id('at1'), 'stored', 'image', 'image/jpeg', 2048, repeat('a', 64), 'org/conv/at1', 640, 480, 'foto.jpg');
select t.reset();
select t.ok('«guardado»: ruta, tipo, tamaño, dimensiones y nombre; sin error',
  (select status = 'stored' and storage_path = 'org/conv/at1' and mime_type = 'image/jpeg' and file_size = 2048 and width = 640 and height = 480 and file_name = 'foto.jpg' and error_code is null from public.message_attachments where id = t.id('at1')));
select t.as_service();
select public.finish_attachment(t.id('at1'), 'failed', p_error => 'otra_vez');
select t.reset();
select t.ok('terminar algo que no estaba «descargando» no cambia nada', (select status = 'stored' from public.message_attachments where id = t.id('at1')));

-- Bloqueado / expirado / vencido en «descargando»
select t.save('at2', (select id from public.message_attachments where message_id = t.id('m2') and position = 0));
select t.as_service(); select public.claim_attachment(t.id('at2')); select public.finish_attachment(t.id('at2'), 'blocked', p_error => 'dangerous_file'); select t.reset();
select t.ok('un archivo peligroso queda «bloqueado» con su motivo y sin ruta', (select status = 'blocked' and error_code = 'dangerous_file' and storage_path is null from public.message_attachments where id = t.id('at2')));
select t.save('at3', (select id from public.message_attachments where message_id = t.id('m2') and position = 4));
select t.as_service(); select public.claim_attachment(t.id('at3')); select t.reset();
update public.message_attachments set updated_at = now() - interval '11 minutes' where id = t.id('at3');
select t.as_service(); select t.ok('un intento que quedó «descargando» demasiado tiempo se reabre', t.id('at3') in (select public.due_attachments(10))); select t.reset();

-- Conservación de 12 meses
update public.message_attachments set expires_at = now() - interval '1 day' where id = t.id('at1');
select t.as_service();
select t.ok('vencido el plazo se devuelve la ruta para borrar el archivo', (select count(*) = 1 and bool_and(storage_path = 'org/conv/at1') from public.expire_attachments(10)));
select t.ok('...y no se repite', (select count(*) = 0 from public.expire_attachments(10)));
select t.reset();
select t.ok('el adjunto queda «expirado» sin ruta (el mensaje se conserva)',
  (select status = 'expired' and storage_path is null from public.message_attachments where id = t.id('at1')) and (select count(*) = 1 from public.messages where id = t.id('m1')));

-- Integridad y permisos
select t.ok('los adjuntos están atados por clave foránea al mensaje, a la conversación y a la organización (no hay adjuntos huérfanos ni de otra organización)',
  (select count(*) = 2 from pg_constraint where conrelid = 'public.message_attachments'::regclass and contype = 'f' and pg_get_constraintdef(oid) like '%org_id%'));
select t.ok('las funciones internas no las ejecuta ningún usuario ni anónimo',
  not has_function_privilege('authenticated', 'public.register_message_attachments(text, text, text, jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_attachment(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.finish_attachment(uuid, text, text, text, bigint, text, text, integer, integer, text, text, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.due_attachments(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.expire_attachments(integer)', 'EXECUTE'));
select t.ok('todas las tablas tienen RLS', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);

rollback;
\echo ✔ ADJUNTOS: TODAS LAS PRUEBAS PASARON
