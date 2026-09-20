-- Pruebas de 0019: envío de archivos (reserva de subida, verificación, encolado con las mismas reglas que el texto, entrega, limpieza).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-c777-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-c777-0000-0000-00000000000b'''
\set S1 '''51000000-c777-0000-0000-000000000001'''
\set PID '''329876543210'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values (:A, 'a@ao.test'), (:B, 'b@ao.test'), (:S1, 's1@ao.test');
select t.as_user(:A); select t.save('orgA', public.create_organization('Envio A', 'envio-a')); select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Envio B', 'envio-b')); select t.reset();
insert into public.memberships (org_id, user_id, role_id) select t.id('orgA'), :S1::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
select t.as_user(:A);
select t.save('wa', public.create_channel(t.id('orgA'), 'Ventas', :PID, '+57 300 000 0000', 'EAAB-token-abcdefghijklmnopqrstuvwxyz'));
select t.save('gm', public.connect_channel(t.id('orgA'), 'gmail', 'Ventas', 'ventas@arkos.co', null, 'Ventas', '1//refresh-token-abcdefghijklmnop'));
select public.create_customer(t.id('orgA'), 'person', 'Cliente admin', '[{"type":"phone","value":"+573001110072"}]'::jsonb);
select t.reset();
select t.as_user(:S1);
select public.create_customer(t.id('orgA'), 'person', 'Cliente vendedor', '[{"type":"phone","value":"+573001110071"},{"type":"email","value":"cliente@ejemplo.com"}]'::jsonb);
select t.reset();
select t.as_service();
select public.ingest_whatsapp_message(:PID, '573001110071', 'Ana', 'wamid.o1', 'text', 'hola', now());
select public.ingest_whatsapp_message(:PID, '573001110072', 'Beto', 'wamid.o2', 'text', 'hola', now());
select public.ingest_channel_message('gmail', 'ventas@arkos.co', 'cliente@ejemplo.com', 'Cliente', 'gm.o1', 'text', 'necesito planos', now());
select t.reset();
select t.save('c1', (select id from public.conversations where thread_key = '573001110071'));      -- del vendedor
select t.save('c2', (select id from public.conversations where thread_key = '573001110072'));      -- del administrador
select t.save('cg', (select id from public.conversations where thread_key = 'cliente@ejemplo.com'));

-- 1) Reservar una subida
select t.as_user(:S1);
select t.save('u1', (public.create_attachment_upload(t.id('c1'), 'foto oficina.jpg', 'image/jpeg', 245000) ->> 'id')::uuid);
select t.ok('la ruta lleva organización / conversación / id (sin el nombre del archivo)',
  (select public.create_attachment_upload(t.id('c1'), 'x.pdf', 'application/pdf', 100) ->> 'path') ~ ('^' || t.id('orgA') || '/' || t.id('c1') || '/[0-9a-f-]{36}$'));
select t.throws('el vendedor no puede subir a la conversación de otro', format('select public.create_attachment_upload(%L, ''a.jpg'', ''image/jpeg'', 10)', t.id('c2')), '42501');
select t.throws('un nombre vacío se rechaza', format('select public.create_attachment_upload(%L, ''  '', ''image/jpeg'', 10)', t.id('c1')), '22023');
select t.throws('un archivo vacío o de más de 100 MB se rechaza', format('select public.create_attachment_upload(%L, ''a.jpg'', ''image/jpeg'', 0)', t.id('c1')), '22023');
select t.throws('...(grande)', format('select public.create_attachment_upload(%L, ''a.jpg'', ''image/jpeg'', 104857601)', t.id('c1')), '22023');
select t.throws('nadie lee ni escribe las subidas directamente', 'select count(*) from public.attachment_uploads', '42501');
select t.reset();
select t.as_user(:B); select t.throws('otra organización no puede subir', format('select public.create_attachment_upload(%L, ''a.jpg'', ''image/jpeg'', 10)', t.id('c1')), '42501'); select t.reset();
select t.as_anon(); select t.throws('un anónimo tampoco', format('select public.create_attachment_upload(%L, ''a.jpg'', ''image/jpeg'', 10)', t.id('c1')), '42501'); select t.reset();

-- freno: 20 subidas pendientes por persona
select t.as_user(:S1);
select public.create_attachment_upload(t.id('c1'), 'f' || g || '.pdf', 'application/pdf', 100) from generate_series(1, 20) g where (select count(*) from public.attachment_uploads) >= 0 and false;
select t.reset();
insert into public.attachment_uploads (org_id, conversation_id, user_id, file_name, mime_type, file_size, storage_path)
  select t.id('orgA'), t.id('c1'), :S1::uuid, 'lote' || g, 'application/pdf', 10, 'lote/' || g from generate_series(1, 20) g;
select t.as_user(:S1);
select t.throws('más de 20 subidas pendientes por persona se frena', format('select public.create_attachment_upload(%L, ''otra.pdf'', ''application/pdf'', 10)', t.id('c1')), '23514');
select t.reset();
delete from public.attachment_uploads where storage_path like 'lote/%';

-- 2) Verificación: solo el servidor
select t.as_user(:S1);
select t.throws('el usuario NO puede marcar su subida como verificada (evita saltarse el control del servidor)', format('select public.verify_attachment_upload(%L, ''image'', ''image/jpeg'', 245000)', t.id('u1')), '42501');
select t.throws('encolar una subida sin verificar se rechaza', format('select public.queue_media_message(%L, array[%L]::uuid[], ''hola'')', t.id('c1'), t.id('u1')), '22023');
select t.reset();
select t.as_service(); select public.verify_attachment_upload(t.id('u1'), 'image', 'image/jpeg', 245000, 640, 480); select t.reset();
select t.ok('el servidor la marca verificada con tipo, tamaño y dimensiones', (select status = 'verified' and kind = 'image' and width = 640 and height = 480 from public.attachment_uploads where id = t.id('u1')));

-- 3) Encolar con las mismas reglas que el texto
select t.as_user(:A);
select t.throws('otro usuario no puede usar la subida de un compañero', format('select public.queue_media_message(%L, array[%L]::uuid[], null)', t.id('c1'), t.id('u1')), '22023');
select t.reset();
select t.as_user(:S1);
select t.throws('ni usarla en otra conversación', format('select public.queue_media_message(%L, array[%L]::uuid[], null)', t.id('c2'), t.id('u1')), '42501');
select t.save('m1', public.queue_media_message(t.id('c1'), array[t.id('u1')], 'Mira la oficina'));
select t.reset();
select t.ok('crea el mensaje con archivo: en cola, del vendedor, con su texto',
  (select kind = 'media' and status = 'queued' and direction = 'outbound' and sent_by = :S1 and body = 'Mira la oficina' from public.messages where id = t.id('m1')));
select t.ok('el adjunto usa el MISMO id y ruta de la subida, dirección saliente, ya «guardado»',
  (select a.id = t.id('u1') and a.direction = 'outbound' and a.status = 'stored' and a.kind = 'image' and a.file_size = 245000 and a.width = 640 and a.storage_path = u.storage_path
     from public.message_attachments a join public.attachment_uploads u on u.id = a.id where a.message_id = t.id('m1')));
select t.ok('la subida queda «usada» y la conversación refleja el envío',
  (select status = 'used' from public.attachment_uploads where id = t.id('u1'))
  and (select last_direction = 'outbound' and needs_reply = false and last_message_preview = 'Mira la oficina' from public.conversations where id = t.id('c1')));
select t.as_user(:S1);
select t.throws('una subida usada no se reutiliza', format('select public.queue_media_message(%L, array[%L]::uuid[], null)', t.id('c1'), t.id('u1')), '22023');
select t.reset();

-- sin texto: etiqueta automática; WhatsApp admite un archivo por mensaje
select t.as_user(:S1);
select t.save('u2', (public.create_attachment_upload(t.id('c1'), 'plano.pdf', 'application/pdf', 5000) ->> 'id')::uuid);
select t.save('u3', (public.create_attachment_upload(t.id('c1'), 'lista.pdf', 'application/pdf', 5000) ->> 'id')::uuid);
select t.reset();
select t.as_service(); select public.verify_attachment_upload(t.id('u2'), 'document', 'application/pdf', 5000); select public.verify_attachment_upload(t.id('u3'), 'document', 'application/pdf', 5000); select t.reset();
select t.as_user(:S1);
select t.throws('WhatsApp: dos archivos en un mensaje se rechazan', format('select public.queue_media_message(%L, array[%L, %L]::uuid[], null)', t.id('c1'), t.id('u2'), t.id('u3')), '22023');
select t.throws('sin archivos también', format('select public.queue_media_message(%L, array[]::uuid[], null)', t.id('c1')), '22023');
select t.throws('el mismo archivo repetido se rechaza', format('select public.queue_media_message(%L, array[%L, %L]::uuid[], null)', t.id('c1'), t.id('u2'), t.id('u2')), '22023');
select t.throws('un texto de más de 4096 caracteres se rechaza', format('select public.queue_media_message(%L, array[%L]::uuid[], %L)', t.id('c1'), t.id('u2'), repeat('a', 4097)), '22023');
select t.save('m2', public.queue_media_message(t.id('c1'), array[t.id('u2')], null));
select t.reset();
select t.ok('sin texto: la etiqueta describe el archivo', (select body = '[Documento: plano.pdf]' from public.messages where id = t.id('m2')));

-- reglas de ventana, pausa y desconexión (iguales al texto)
update public.conversations set last_inbound_at = now() - interval '25 hours' where id = t.id('c1');
select t.as_user(:S1);
select t.throws('pasadas 24 h no se puede enviar (WhatsApp)', format('select public.queue_media_message(%L, array[%L]::uuid[], null)', t.id('c1'), t.id('u3')), '23514');
select t.reset();
update public.conversations set last_inbound_at = now() where id = t.id('c1');
update public.channels set status = 'paused' where id = t.id('wa');
select t.as_user(:S1); select t.throws('con el canal en pausa no se envía', format('select public.queue_media_message(%L, array[%L]::uuid[], null)', t.id('c1'), t.id('u3')), '23514'); select t.reset();
update public.channels set status = 'active', connection_status = 'disconnected' where id = t.id('wa');
select t.as_user(:S1); select t.throws('con el número desconectado no se envía', format('select public.queue_media_message(%L, array[%L]::uuid[], null)', t.id('c1'), t.id('u3')), '23514'); select t.reset();
update public.channels set connection_status = 'connected' where id = t.id('wa');

-- 4) Gmail: varios adjuntos, tope de 25 MB en total, 30 días
select t.as_user(:S1);
select t.save('g1', (public.create_attachment_upload(t.id('cg'), 'a.pdf', 'application/pdf', 10000000) ->> 'id')::uuid);
select t.save('g2', (public.create_attachment_upload(t.id('cg'), 'b.png', 'image/png', 10000000) ->> 'id')::uuid);
select t.save('g3', (public.create_attachment_upload(t.id('cg'), 'c.zip', 'application/zip', 10000000) ->> 'id')::uuid);
select t.reset();
select t.as_service(); select public.verify_attachment_upload(t.id('g1'), 'document', 'application/pdf', 10000000); select public.verify_attachment_upload(t.id('g2'), 'image', 'image/png', 10000000); select public.verify_attachment_upload(t.id('g3'), 'file', 'application/zip', 10000000); select t.reset();
select t.as_user(:S1);
select t.throws('Gmail: más de 25 MB en total se rechaza', format('select public.queue_media_message(%L, array[%L, %L, %L]::uuid[], ''Adjunto'')', t.id('cg'), t.id('g1'), t.id('g2'), t.id('g3')), '22023');
select t.throws('Gmail: el mismo archivo repetido se rechaza', format('select public.queue_media_message(%L, array[%L, %L]::uuid[], null)', t.id('cg'), t.id('g1'), t.id('g1')), '22023');
select t.save('mg', public.queue_media_message(t.id('cg'), array[t.id('g1'), t.id('g2')], null));
select t.reset();
select t.ok('Gmail: varios adjuntos en un mensaje, en orden, con etiqueta «[2 adjuntos]»',
  (select body = '[2 adjuntos]' from public.messages where id = t.id('mg'))
  and (select array_agg(file_name order by position) = array['a.pdf', 'b.png'] from public.message_attachments where message_id = t.id('mg')));
update public.conversations set last_inbound_at = now() - interval '5 days' where id = t.id('cg');
select t.as_user(:S1);
select t.save('g4', (public.create_attachment_upload(t.id('cg'), 'd.pdf', 'application/pdf', 100) ->> 'id')::uuid);
select t.reset();
select t.as_service(); select public.verify_attachment_upload(t.id('g4'), 'document', 'application/pdf', 100); select t.reset();
select t.as_user(:S1); select t.ok('Gmail: 5 días después todavía se puede', public.queue_media_message(t.id('cg'), array[t.id('g4')], 'Seguimos') is not null); select t.reset();

-- 5) La entrega recibe los adjuntos
select t.as_service();
select t.ok('claim_outbound trae los adjuntos en orden, con ruta y tipo',
  (select jsonb_array_length(c -> 'attachments') = 2 and (c -> 'attachments' -> 0 ->> 'file_name') = 'a.pdf' and (c -> 'attachments' -> 1 ->> 'mime_type') = 'image/png'
          and (c -> 'attachments' -> 0 ->> 'storage_path') like t.id('orgA') || '/' || t.id('cg') || '/%' from (select public.claim_outbound(t.id('mg')) as c) x));
select t.reset();
select t.as_user(:S1); select t.save('mt', public.queue_message(t.id('c1'), 'solo texto')); select t.reset();
select t.as_service(); select t.ok('un mensaje de texto trae la lista vacía', (select jsonb_array_length(c -> 'attachments') = 0 from (select public.claim_outbound(t.id('mt')) as c) x)); select t.reset();

-- 6) Cancelar y limpiar
select t.as_user(:S1);
select t.save('u9', (public.create_attachment_upload(t.id('c1'), 'x.pdf', 'application/pdf', 100) ->> 'id')::uuid);
select t.save('u10', (public.create_attachment_upload(t.id('c1'), 'y.pdf', 'application/pdf', 100) ->> 'id')::uuid);
select t.reset();
select t.as_user(:A); select t.ok('un compañero NO puede cancelar la subida vigente de otro', public.cancel_attachment_upload(t.id('u10')) is null); select t.reset();
select t.ok('...y esa subida sigue vigente', (select status = 'created' from public.attachment_uploads where id = t.id('u10')));
select t.as_user(:S1);
select t.ok('cancelar una subida propia devuelve su ruta', public.cancel_attachment_upload(t.id('u9')) like t.id('orgA') || '/%');
select t.reset();
update public.attachment_uploads set expires_at = now() - interval '1 minute' where id <> t.id('u9');      -- vence TODO, también lo ya usado: lo usado NUNCA se limpia (su archivo es el que se envió)
create table t.purged (id uuid, storage_path text); grant all on table t.purged to public;
select t.as_service(); insert into t.purged select * from public.purge_stale_uploads(50); select t.reset();
select t.ok('la limpieza devuelve las rutas de lo abandonado y cancelado', (select count(*) >= 2 from t.purged) and (select bool_and(storage_path like t.id('orgA') || '/%') from t.purged));
select t.ok('...las borra, y NO toca lo usado aunque su plazo haya vencido (devolver su ruta borraría el archivo ya enviado)', (select count(*) = 0 from public.attachment_uploads where status in ('created', 'cancelled', 'verified'))
  and (select count(*) >= 4 from public.attachment_uploads where status = 'used')
  and (select count(*) = 0 from t.purged p join public.message_attachments a on a.storage_path = p.storage_path));

-- 7) Permisos
select t.ok('las funciones del servidor no las ejecuta ningún usuario ni anónimo',
  not has_function_privilege('authenticated', 'public.verify_attachment_upload(uuid, text, text, bigint, integer, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_attachment_upload(uuid, uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.purge_stale_uploads(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.queue_media_message(uuid, uuid[], text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_attachment_upload(uuid, text, text, bigint)', 'EXECUTE'));
select t.ok('todas las tablas tienen RLS', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);

rollback;
\echo ✔ ADJUNTOS SALIENTES: TODAS LAS PRUEBAS PASARON
