-- Pruebas de 0039: formulario BASE del widget (Entrega 4) — el que el visitante siempre ve, sin necesitar
-- ningún menú de intenciones. Cubre: aislamiento multiempresa, permisos, claves foráneas compuestas, cascadas,
-- y que `get_widget_config` entregue la llave `fields` en el mismo formato que los campos de una intención.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-e666-0000-0000-00000000000a'''
\set B '''bbbbbbbb-e666-0000-0000-00000000000b'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@wdf.test'), (:B, 'b@wdf.test');
select t.as_user(:A); select t.save('orgA', public.create_organization('Widget Default Fields A', 'wdf-a')); select t.reset();
select t.as_user(:A); select t.save('wa', public.create_channel(t.id('orgA'), 'Ventas', '7000014', '+57 300 000 0014', 'token-wdf-abcdefghijklmnop')); select t.reset();
select t.as_user(:A);
insert into public.whatsapp_widgets (org_id, channel_id, name, allowed_domains) values (t.id('orgA'), t.id('wa'), 'Web principal', array['arkos.com.co']);
select t.reset();
select t.save('widget', (select id from public.whatsapp_widgets where name = 'Web principal' and org_id = t.id('orgA')));

select t.as_user(:B); select t.save('orgB', public.create_organization('Widget Default Fields B', 'wdf-b')); select t.reset();
select t.as_user(:B); select t.save('waB', public.create_channel(t.id('orgB'), 'Ventas B', '7000015', '+57 300 000 0015', 'token-wdf-b-abcdefghijklmnop')); select t.reset();
select t.as_user(:B);
insert into public.whatsapp_widgets (org_id, channel_id, name, allowed_domains) values (t.id('orgB'), t.id('waB'), 'Web B', array['otraempresa.com']);
select t.reset();
select t.save('widgetB', (select id from public.whatsapp_widgets where name = 'Web B' and org_id = t.id('orgB')));

select t.as_user(:A);
insert into public.widget_fields (org_id, key, label) values (t.id('orgA'), 'empresa', 'Empresa');
select t.reset();
select t.save('f_empresa', (select id from public.widget_fields where org_id = t.id('orgA') and key = 'empresa'));

-- --------------------------------------------------------------------------------------- 1. agregar al formulario base
select t.as_user(:A);
insert into public.widget_default_fields (org_id, widget_id, field_id, position, required) values (t.id('orgA'), t.id('widget'), t.id('f_empresa'), 10, true);
select t.reset();
select t.ok('el campo queda en el formulario base, con su obligatoriedad', (select required from public.widget_default_fields where widget_id = t.id('widget') and field_id = t.id('f_empresa')));

select t.ok('get_widget_config trae "fields" con el formulario base en el mismo formato que una intención',
  (select public.get_widget_config(t.id('widget')) -> 'fields' = jsonb_build_array(jsonb_build_object(
    'fieldId', t.id('f_empresa'), 'key', 'empresa', 'type', 'text', 'label', 'Empresa', 'placeholder', null, 'options', '[]'::jsonb, 'required', true, 'defaultValue', null
  ))));

-- --------------------------------------------------------------------------------------- 2. no se puede mezclar entre organizaciones
select t.as_user(:A);
select t.throws('un campo o widget de otra organización no se puede mezclar (clave foránea compuesta)',
  format('insert into public.widget_default_fields (org_id, widget_id, field_id, position) values (%L, %L, %L, 10)', t.id('orgA'), t.id('widgetB'), t.id('f_empresa')), '23503');
select t.save('f_empresaB', (select id from public.widget_fields where org_id = t.id('orgB')));
select t.as_user(:B); insert into public.widget_fields (org_id, key, label) values (t.id('orgB'), 'campox', 'X'); select t.reset();
select t.save('f_xB', (select id from public.widget_fields where org_id = t.id('orgB') and key = 'campox'));
select t.as_user(:A);
select t.throws('un campo de otra organización no se puede asignar al formulario base propio (RLS)',
  format('insert into public.widget_default_fields (org_id, widget_id, field_id, position) values (%L, %L, %L, 20)', t.id('orgA'), t.id('widget'), t.id('f_xB')), '42501');
select t.reset();

-- --------------------------------------------------------------------------------------- 3. aislamiento y permisos
select t.as_user(:B);
select t.ok('la organización B no ve el formulario base del widget de A', (select count(*) = 0 from public.widget_default_fields where widget_id = t.id('widget')));
select t.reset();

insert into auth.users (id, email) values ('54000000-e666-0000-0000-000000000004', 's4@wdf.test');
insert into public.memberships (org_id, user_id, role_id) select t.id('orgA'), '54000000-e666-0000-0000-000000000004'::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
select t.as_user('54000000-e666-0000-0000-000000000004');
select t.ok('un vendedor no ve el formulario base (no tiene settings:manage)', (select count(*) = 0 from public.widget_default_fields));
select t.throws('ni puede agregar un campo', format('insert into public.widget_default_fields (org_id, widget_id, field_id, position) values (%L, %L, %L, 30)', t.id('orgA'), t.id('widget'), t.id('f_empresa')), '42501');
select t.reset();

-- --------------------------------------------------------------------------------------- 4. cascadas
select t.as_user(:A);
delete from public.widget_fields where id = t.id('f_empresa');
select t.reset();
select t.ok('borrar un campo del catálogo lo quita del formulario base que lo usaba', (select count(*) = 0 from public.widget_default_fields where field_id = t.id('f_empresa')));

select t.as_user(:A);
insert into public.widget_fields (org_id, key, label) values (t.id('orgA'), 'ciudad', 'Ciudad');
select t.reset();
select t.save('f_ciudad', (select id from public.widget_fields where org_id = t.id('orgA') and key = 'ciudad'));
select t.as_user(:A);
insert into public.widget_default_fields (org_id, widget_id, field_id, position) values (t.id('orgA'), t.id('widget'), t.id('f_ciudad'), 10);
delete from public.whatsapp_widgets where id = t.id('widget');
select t.reset();
select t.ok('borrar el widget borra su formulario base', (select count(*) = 0 from public.widget_default_fields where widget_id = t.id('widget')));
select t.ok('…pero el catálogo de campos de la organización NO se borra', (select count(*) = 1 from public.widget_fields where org_id = t.id('orgA') and key = 'ciudad'));

rollback;
\echo ✔ FORMULARIO BASE DEL WIDGET (0039): TODAS LAS PRUEBAS PASARON
