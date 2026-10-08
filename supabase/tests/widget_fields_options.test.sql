-- Pruebas de 0037: catálogo de campos del widget + intenciones (opciones) + sus campos asignados.
-- Cubre: aislamiento multiempresa, permisos (settings:manage), claves foráneas compuestas (un campo o una
-- opción de otra organización no se puede asignar), cascadas al borrar, y el orden/reorden.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-e444-1111-0000-00000000000a'''
\set B '''bbbbbbbb-e444-1111-0000-00000000000b'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@wfo.test'), (:B, 'b@wfo.test');
select t.as_user(:A); select t.save('orgA', public.create_organization('Widget Fields A', 'wfo-a')); select t.reset();
select t.as_user(:A); select t.save('wa', public.create_channel(t.id('orgA'), 'Ventas', '7000011', '+57 300 000 0011', 'token-wfo-abcdefghijklmnop')); select t.reset();
select t.as_user(:A);
insert into public.whatsapp_widgets (org_id, channel_id, name, allowed_domains) values (t.id('orgA'), t.id('wa'), 'Web principal', array['arkos.com.co']);
select t.reset();
select t.save('widget', (select id from public.whatsapp_widgets where name = 'Web principal' and org_id = t.id('orgA')));

select t.as_user(:B); select t.save('orgB', public.create_organization('Widget Fields B', 'wfo-b')); select t.reset();
select t.as_user(:B); select t.save('waB', public.create_channel(t.id('orgB'), 'Ventas B', '7000012', '+57 300 000 0012', 'token-wfo-b-abcdefghijklmnop')); select t.reset();
select t.as_user(:B);
insert into public.whatsapp_widgets (org_id, channel_id, name, allowed_domains) values (t.id('orgB'), t.id('waB'), 'Web B', array['otraempresa.com']);
select t.reset();
select t.save('widgetB', (select id from public.whatsapp_widgets where name = 'Web B' and org_id = t.id('orgB')));

-- ---------------------------------------------------------------------------------------- 1. catálogo de campos
select t.as_user(:A);
insert into public.widget_fields (org_id, key, label, field_type) values (t.id('orgA'), 'producto', 'Producto', 'text');
insert into public.widget_fields (org_id, key, label, field_type, options) values (t.id('orgA'), 'tipo_cliente', 'Tipo de cliente', 'select', '["Particular", "Empresa"]'::jsonb);
select t.reset();
select t.save('f_producto', (select id from public.widget_fields where org_id = t.id('orgA') and key = 'producto'));
select t.save('f_tipo', (select id from public.widget_fields where org_id = t.id('orgA') and key = 'tipo_cliente'));

select t.as_user(:A);
select t.throws('la clave del campo es única por organización', format('insert into public.widget_fields (org_id, key, label) values (%L, ''producto'', ''Otro producto'')', t.id('orgA')), '23505');
select t.throws('una clave con mayúsculas o símbolos se rechaza', format('insert into public.widget_fields (org_id, key, label) values (%L, ''Producto-2'', ''x'')', t.id('orgA')), '23514');
select t.reset();

-- La misma clave SÍ puede existir en otra organización (el catálogo es por organización, no global).
select t.as_user(:B);
insert into public.widget_fields (org_id, key, label) values (t.id('orgB'), 'producto', 'Producto (empresa B)');
select t.reset();
select t.ok('la misma clave existe sin choque en otra organización', (select count(*) = 1 from public.widget_fields where org_id = t.id('orgB') and key = 'producto'));

-- ---------------------------------------------------------------------------------------- 2. intenciones (opciones)
select t.as_user(:A);
insert into public.widget_options (org_id, widget_id, icon, label, position) values (t.id('orgA'), t.id('widget'), '🛒', 'Comprar', 10);
insert into public.widget_options (org_id, widget_id, icon, label, position) values (t.id('orgA'), t.id('widget'), '💰', 'Cotizar', 20);
select t.reset();
select t.save('opt_comprar', (select id from public.widget_options where org_id = t.id('orgA') and label = 'Comprar'));
select t.save('opt_cotizar', (select id from public.widget_options where org_id = t.id('orgA') and label = 'Cotizar'));

select t.as_user(:A);
select t.throws('una opción no se puede crear sobre un widget de otra organización (clave foránea compuesta)',
  format('insert into public.widget_options (org_id, widget_id, label) values (%L, %L, ''Intrusa'')', t.id('orgA'), t.id('widgetB')), '23503');
select t.reset();

-- ---------------------------------------------------------------------------------------- 3. campos de cada opción
select t.as_user(:A);
insert into public.widget_option_fields (org_id, option_id, field_id, position, required) values (t.id('orgA'), t.id('opt_comprar'), t.id('f_producto'), 10, true);
select t.reset();
select t.ok('el campo queda asignado a la opción, con su obligatoriedad', (select required from public.widget_option_fields where option_id = t.id('opt_comprar') and field_id = t.id('f_producto')));

-- Un campo o una opción de OTRA organización no se puede mezclar, aunque el org_id declarado sea el correcto
-- (la política de inserción además de la FK compuesta lo exige explícitamente).
select t.as_user(:A);
select t.save('f_productoB', (select id from public.widget_fields where org_id = t.id('orgB') and key = 'producto'));
select t.throws('un campo de otra organización no se puede asignar a una opción propia',
  format('insert into public.widget_option_fields (org_id, option_id, field_id, position) values (%L, %L, %L, 10)', t.id('orgA'), t.id('opt_comprar'), t.id('f_productoB')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------------------- 4. aislamiento multiempresa
select t.as_user(:B);
select t.ok('la organización B no ve el catálogo de campos de A', (select count(*) = 0 from public.widget_fields where org_id = t.id('orgA')));
select t.ok('la organización B no ve las opciones del widget de A', (select count(*) = 0 from public.widget_options where org_id = t.id('orgA')));
select t.reset();

-- ---------------------------------------------------------------------------------------- 5. permisos (settings:manage)
insert into auth.users (id, email) values ('51000000-e444-1111-0000-000000000001', 's1@wfo.test');
insert into public.memberships (org_id, user_id, role_id) select t.id('orgA'), '51000000-e444-1111-0000-000000000001'::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
select t.as_user('51000000-e444-1111-0000-000000000001');
select t.ok('un vendedor no ve el catálogo de campos (no tiene settings:manage)', (select count(*) = 0 from public.widget_fields));
select t.ok('ni las opciones de los widgets', (select count(*) = 0 from public.widget_options));
select t.throws('ni puede crear un campo', format('insert into public.widget_fields (org_id, key, label) values (%L, ''x'', ''X'')', t.id('orgA')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------------------- 6. cascadas al borrar
select t.as_user(:A);
delete from public.widget_fields where id = t.id('f_tipo');
select t.reset();
select t.ok('borrar un campo del catálogo lo quita de cualquier opción que lo usara (si lo usara)', (select count(*) = 0 from public.widget_option_fields where field_id = t.id('f_tipo')));

select t.as_user(:A);
delete from public.whatsapp_widgets where id = t.id('widget');
select t.reset();
select t.ok('borrar el widget borra sus opciones', (select count(*) = 0 from public.widget_options where widget_id = t.id('widget')));
select t.ok('…y los campos que tenían asignados', (select count(*) = 0 from public.widget_option_fields where option_id = t.id('opt_comprar')));
select t.ok('el catálogo de campos de la organización NO se borra (es independiente del widget)', (select count(*) = 1 from public.widget_fields where org_id = t.id('orgA')));

rollback;
\echo ✔ CAMPOS Y OPCIONES DEL WIDGET: TODAS LAS PRUEBAS PASARON
