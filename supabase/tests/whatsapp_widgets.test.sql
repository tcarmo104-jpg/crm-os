-- Pruebas de 0034: widget de WhatsApp — validación de dominio, límite de velocidad, y que crea el contacto
-- real con toda su atribución, usando el mismo motor que ya usa la API pública de leads.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-e444-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@ww.test');
select t.as_user(:A); select t.save('org', public.create_organization('Widget Test', 'widget-test')); select t.reset();
select t.as_user(:A); select t.save('wa', public.create_channel(t.id('org'), 'Ventas', '7000009', '+57 300 000 0009', 'token-wa-abcdefghijklmnop')); select t.reset();

-- ---- Crear el widget (directo por tabla, con RLS)
select t.as_user(:A);
insert into public.whatsapp_widgets (org_id, channel_id, name, allowed_domains) values (t.id('org'), t.id('wa'), 'Web principal', array['arkos.com.co']);
select t.reset();
select t.save('widget', (select id from public.whatsapp_widgets where name = 'Web principal'));

-- ---- Configuración pública: no expone nada sensible
select t.ok('get_widget_config no trae org_id ni canal, solo lo visual',
  (select public.get_widget_config(t.id('widget')) ?& array['active', 'buttonText', 'position', 'color', 'size'] and not public.get_widget_config(t.id('widget')) ? 'org_id'));
select t.ok('un widget que no existe devuelve active=false (no un error)', (select (public.get_widget_config(gen_random_uuid()) ->> 'active')::boolean = false));

-- ---- Dominio no autorizado: se rechaza
select t.ok('un dominio que no está en la lista permitida se rechaza',
  (select public.start_widget_conversation(t.id('widget'), 'sitio-pirata.com', 'Ana', '+573001112222', null, 'Hola', null, null, null, null, null, null, null) ->> 'reason' = 'domain_not_allowed'));

-- ---- Dominio autorizado (exacto y un subdominio): se acepta y crea el contacto real
select t.ok('el dominio exacto autorizado funciona',
  (select (public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Ana Gómez', '+573001112222', 'Mi Empresa', 'Quiero información', 'https://arkos.com.co/productos/x', 'https://google.com', 'https://arkos.com.co/productos/x', 'google', 'cpc', 'verano2026', 'anuncio1') ->> 'ok')::boolean));
select t.ok('un subdominio del dominio autorizado también funciona',
  (select (public.start_widget_conversation(t.id('widget'), 'www.arkos.com.co', 'Beto', '+573001112223', null, 'Hola', null, null, null, null, null, null, null) ->> 'ok')::boolean));

select t.ok('se creó un cliente real a partir del widget', (select count(*) = 2 from public.customers where org_id = t.id('org')));
select t.ok('el lead quedó con source=widget_web y toda la atribución guardada',
  (select source = 'widget_web' and channel = 'whatsapp' and (raw_payload ->> 'utm_source') = 'google' and (raw_payload ->> 'utm_campaign') = 'verano2026' and (raw_payload ->> 'widget_name') = 'Web principal'
   from public.leads where contact_phone = '+573001112222'));
select t.ok('devuelve el número de WhatsApp real para armar el enlace de redirección',
  (select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Carla', '+573001112224', null, 'Hola', null, null, null, null, null, null, null) ->> 'phone' = '+57 300 000 0009'));
select t.ok('el contador de conversaciones del widget sube', (select conversations_count = 3 from public.whatsapp_widgets where id = t.id('widget')));

-- ---- Un segundo contacto desde el MISMO teléfono no se duplica (reutiliza ingest_lead_core)
select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Ana Gómez', '+573001112222', null, 'Otra vez', null, null, null, null, null, null, null);
select t.ok('el mismo teléfono no crea un segundo cliente', (select count(*) = 3 from public.customers where org_id = t.id('org')));

-- ---- Datos inválidos se rechazan sin crear nada
select t.ok('un teléfono demasiado corto se rechaza', (select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Dani', '123', null, 'x', null, null, null, null, null, null, null) ->> 'reason' = 'invalid_phone'));
select t.ok('sin nombre se rechaza', (select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', '', '+573001112225', null, 'x', null, null, null, null, null, null, null) ->> 'reason' = 'invalid_name'));

-- ---- Límite de velocidad: más de 20 solicitudes en el mismo minuto se rechazan
select count(*) > 0 as hubo_limite from (
  select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Spam ' || n, '+5730011130' || lpad(n::text, 2, '0'), null, 'x', null, null, null, null, null, null, null) ->> 'reason' as reason
  from generate_series(1, 25) n
) spam where reason = 'rate_limited' \gset
select t.ok('pasadas 20 solicitudes en el mismo minuto, las siguientes se rechazan por límite de velocidad', (:'hubo_limite')::boolean);

-- ---- Un widget desactivado no funciona
select t.as_user(:A); update public.whatsapp_widgets set active = false where id = t.id('widget'); select t.reset();
select t.ok('un widget desactivado se rechaza', (select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Eva', '+573001112226', null, 'x', null, null, null, null, null, null, null) ->> 'reason' = 'not_found'));
select t.as_user(:A); update public.whatsapp_widgets set active = true where id = t.id('widget'); select t.reset();

-- ---- No se puede crear un widget apuntando a un canal que no es de WhatsApp
select t.as_user(:A); select t.save('gmail', public.connect_channel(t.id('org'), 'gmail', 'Correo', 'ventas@widget-test.com', null, 'Correo', 'token-gmail-abcdefghijklmnop')); select t.reset();
select t.as_user(:A);
select t.throws('un widget no se puede crear sobre un canal que no sea WhatsApp',
  format('insert into public.whatsapp_widgets (org_id, channel_id, name, allowed_domains) values (%L, %L, ''Malo'', array[''x.com''])', t.id('org'), t.id('gmail')), '42501');
select t.reset();

-- ---- Solo quien tiene settings:manage puede crear/ver widgets
insert into auth.users (id, email) values ('51000000-e444-0000-0000-000000000001', 's1@ww.test');
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), '51000000-e444-0000-0000-000000000001'::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
select t.as_user('51000000-e444-0000-0000-000000000001');
select t.ok('un vendedor no ve los widgets (no tiene settings:manage)', (select count(*) = 0 from public.whatsapp_widgets));
select t.reset();

rollback;
\echo ✔ WIDGET DE WHATSAPP: TODAS LAS PRUEBAS PASARON
