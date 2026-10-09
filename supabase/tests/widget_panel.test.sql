-- Pruebas de 0038: panel del widget renovado — `get_widget_config` ahora también entrega el menú de
-- intenciones (con sus campos), si está dentro de horario de atención, y el asesor a mostrar;
-- `start_widget_conversation` ahora guarda qué intención se eligió y las respuestas de sus campos.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-e555-0000-0000-00000000000a'''
\set B '''bbbbbbbb-e555-0000-0000-00000000000b'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@wp.test'), (:B, 'b@wp.test');
select t.as_user(:A); select t.save('org', public.create_organization('Widget Panel', 'widget-panel')); select t.reset();
select t.as_user(:A); select t.save('wa', public.create_channel(t.id('org'), 'Ventas', '7000013', '+57 300 000 0013', 'token-wp-abcdefghijklmnop')); select t.reset();
select t.as_user(:A);
insert into public.whatsapp_widgets (org_id, channel_id, name, allowed_domains) values (t.id('org'), t.id('wa'), 'Web principal', array['arkos.com.co']);
select t.reset();
select t.save('widget', (select id from public.whatsapp_widgets where name = 'Web principal' and org_id = t.id('org')));

select t.as_user(:B); select t.save('orgB', public.create_organization('Widget Panel B', 'widget-panel-b')); select t.reset();
insert into auth.users (id, email) values ('52000000-e555-0000-0000-000000000002', 's2@wp.test');
insert into public.memberships (org_id, user_id, role_id) select t.id('orgB'), '52000000-e555-0000-0000-000000000002'::uuid, r.id from public.roles r where r.key = 'admin' and r.org_id is null;

-- --------------------------------------------------------------------------------------- 1. sin nada configurado
select t.ok('sin horario ni menú configurados, el widget sigue "siempre abierto" (sin regresión)',
  (select (public.get_widget_config(t.id('widget')) ->> 'isOpen')::boolean and (public.get_widget_config(t.id('widget')) -> 'options') = '[]'::jsonb));

-- --------------------------------------------------------------------------------------- 2. asesor: debe ser de la misma organización
insert into auth.users (id, email) values ('53000000-e555-0000-0000-000000000003', 's3@wp.test');
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), '53000000-e555-0000-0000-000000000003'::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
update public.profiles set full_name = 'Lucía Vendedora' where id = '53000000-e555-0000-0000-000000000003';

select t.as_user(:A);
select t.throws('el asesor del widget debe ser alguien de la misma organización',
  format('update public.whatsapp_widgets set show_advisor = true, advisor_user_id = %L where id = %L', '52000000-e555-0000-0000-000000000002', t.id('widget')), '42501');
update public.whatsapp_widgets set show_advisor = true, advisor_user_id = '53000000-e555-0000-0000-000000000003' where id = t.id('widget');
select t.reset();
select t.ok('el asesor de la misma organización sí se puede asignar, y get_widget_config lo muestra',
  (select public.get_widget_config(t.id('widget')) -> 'advisor' = jsonb_build_object('name', 'Lucía Vendedora', 'avatarUrl', null)));

-- --------------------------------------------------------------------------------------- 3. horario de atención
select t.as_user(:A);
select t.throws('una franja con un día fuera de 0-6 se rechaza', format('update public.whatsapp_widgets set business_hours = %L where id = %L', '[{"day":7,"from":"09:00","to":"18:00"}]', t.id('widget')), '23514');
select t.throws('una franja con una hora mal formada se rechaza', format('update public.whatsapp_widgets set business_hours = %L where id = %L', '[{"day":1,"from":"9am","to":"18:00"}]', t.id('widget')), '23514');
-- Un horario que NO incluye el día de hoy deja el widget "cerrado" ahora mismo, sea la hora que sea.
update public.whatsapp_widgets set business_hours = jsonb_build_array(jsonb_build_object('day', (extract(dow from (now() at time zone 'America/Bogota')) + 1)::int % 7, 'from', '00:00', 'to', '23:59')), out_of_hours_message = 'Fuera de horario, te escribimos pronto.' where id = t.id('widget');
select t.reset();
select t.ok('con un horario que no cubre hoy, el widget queda cerrado y entrega el mensaje configurado',
  (select not (public.get_widget_config(t.id('widget')) ->> 'isOpen')::boolean and public.get_widget_config(t.id('widget')) ->> 'outOfHoursMessage' = 'Fuera de horario, te escribimos pronto.'));

select t.as_user(:A);
-- Un horario que SÍ incluye todo el día de hoy: el widget queda abierto.
update public.whatsapp_widgets set business_hours = jsonb_build_array(jsonb_build_object('day', extract(dow from (now() at time zone 'America/Bogota'))::int, 'from', '00:00', 'to', '23:59')) where id = t.id('widget');
select t.reset();
select t.ok('con un horario que cubre todo el día de hoy, el widget queda abierto', (select (public.get_widget_config(t.id('widget')) ->> 'isOpen')::boolean));
select t.as_user(:A); update public.whatsapp_widgets set business_hours = '[]'::jsonb, out_of_hours_message = null where id = t.id('widget'); select t.reset();

-- --------------------------------------------------------------------------------------- 4. menú de intenciones con sus campos
select t.as_user(:A);
insert into public.widget_fields (org_id, key, label, field_type) values (t.id('org'), 'producto', 'Producto', 'text');
select t.reset();
select t.save('f_producto', (select id from public.widget_fields where org_id = t.id('org') and key = 'producto'));
select t.as_user(:A);
insert into public.widget_options (org_id, widget_id, icon, label, position, message_template) values (t.id('org'), t.id('widget'), '🛒', 'Comprar', 10, 'Hola, soy {{nombre}}, quiero {{producto}}.');
select t.reset();
select t.save('opt', (select id from public.widget_options where org_id = t.id('org') and label = 'Comprar'));
select t.as_user(:A);
insert into public.widget_option_fields (org_id, option_id, field_id, position, required) values (t.id('org'), t.id('opt'), t.id('f_producto'), 10, true);
select t.reset();

select t.ok('el menú trae la opción activa con su campo propio (clave, tipo, obligatoriedad y plantilla)',
  (select public.get_widget_config(t.id('widget')) -> 'options' = jsonb_build_array(jsonb_build_object(
    'id', t.id('opt'), 'icon', '🛒', 'label', 'Comprar', 'messageTemplate', 'Hola, soy {{nombre}}, quiero {{producto}}.',
    'fields', jsonb_build_array(jsonb_build_object('fieldId', t.id('f_producto'), 'key', 'producto', 'type', 'text', 'label', 'Producto', 'placeholder', null, 'options', '[]'::jsonb, 'required', true, 'defaultValue', null))
  ))));

select t.as_user(:A); update public.widget_options set active = false where id = t.id('opt'); select t.reset();
select t.ok('una opción desactivada no aparece en el menú público', (select public.get_widget_config(t.id('widget')) -> 'options' = '[]'::jsonb));
select t.as_user(:A); update public.widget_options set active = true where id = t.id('opt'); select t.reset();

-- --------------------------------------------------------------------------------------- 5. start_widget_conversation guarda la intención y sus respuestas
select t.ok('al elegir una intención, queda guardada junto con las respuestas de sus campos',
  (select (public.start_widget_conversation(
    t.id('widget'), 'arkos.com.co', 'Fede', '+573001112277', null, null, null, null, null, null, null, null, null,
    t.id('opt'), jsonb_build_object('producto', 'Camisetas')
  ) ->> 'ok')::boolean));
select t.ok('la intención y el valor del campo quedan en la atribución del lead',
  (select (raw_payload ->> 'option_label') = 'Comprar' and (raw_payload -> 'field_values' ->> 'producto') = 'Camisetas'
   from public.leads where contact_phone = '+573001112277'));

-- Una intención de OTRO widget (o inexistente) se ignora en vez de hacer fallar el contacto.
select t.ok('una intención que no corresponde a este widget simplemente se ignora (no falla)',
  (select (public.start_widget_conversation(
    t.id('widget'), 'arkos.com.co', 'Gina', '+573001112278', null, null, null, null, null, null, null, null, null,
    gen_random_uuid(), null
  ) ->> 'ok')::boolean));
select t.ok('…y no queda ninguna intención guardada para ese contacto', (select (raw_payload ->> 'option_id') is null from public.leads where contact_phone = '+573001112278'));

-- Más de 20 respuestas nunca deben tumbar la solicitud: se recortan a 20 como máximo.
select t.ok('más de 20 respuestas de campos no hacen fallar la solicitud',
  (select (public.start_widget_conversation(
    t.id('widget'), 'arkos.com.co', 'Harry', '+573001112279', null, null, null, null, null, null, null, null, null,
    null, (select jsonb_object_agg('campo' || n, 'x') from generate_series(1, 30) n)
  ) ->> 'ok')::boolean));
select t.ok('…y lo guardado queda recortado a 20 llaves',
  (select (select count(*) from jsonb_each(raw_payload -> 'field_values')) <= 20 from public.leads where contact_phone = '+573001112279'));

rollback;
\echo ✔ PANEL DEL WIDGET (0038): TODAS LAS PRUEBAS PASARON
