-- Pruebas de campos personalizados: definiciones, permisos y validación de valores por tipo.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set S1 '''51000000-0000-0000-0000-000000000001'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values (:A, 'a@acme.test'), (:B, 'b@beta.test'), (:S1, 's1@acme.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1);
select t.as_user(:A); select t.save('orgA', public.create_organization('Acme', 'acme'));
insert into public.memberships (org_id, user_id, role_id)
  select t.id('orgA'), :S1, id from public.roles where key = 'sales_agent' and org_id is null;
select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Beta', 'beta')); select t.reset();

-- Definiciones
select t.as_user(:A);
insert into public.custom_field_definitions (org_id, entity, key, label, type, options) values
  (t.id('orgA'), 'customer', 'notas',   'Notas',        'text',         '[]'),
  (t.id('orgA'), 'customer', 'edad',    'Edad',         'number',       '[]'),
  (t.id('orgA'), 'customer', 'nacio',   'Nacimiento',   'date',         '[]'),
  (t.id('orgA'), 'customer', 'nivel',   'Nivel',        'select',       '["oro","plata"]'),
  (t.id('orgA'), 'customer', 'gustos',  'Gustos',       'multi_select', '["a","b","c"]'),
  (t.id('orgA'), 'customer', 'vip',     'VIP',          'boolean',      '[]'),
  (t.id('orgA'), 'customer', 'ingreso', 'Ingreso',      'currency',     '[]'),
  (t.id('orgA'), 'customer', 'web',     'Sitio',        'url',          '[]'),
  (t.id('orgA'), 'customer', 'tel2',    'Teléfono 2',   'phone',        '[]'),
  (t.id('orgA'), 'customer', 'mail2',   'Email 2',      'email',        '[]');
select t.ok('admin crea definiciones', (select count(*) from public.custom_field_definitions) = 10);
select t.throws('un select sin opciones es inválido',
  format('insert into public.custom_field_definitions (org_id, entity, key, label, type) values (%L, ''customer'', ''sel'', ''Sel'', ''select'')', t.id('orgA')), '23514');
select t.throws('un texto con opciones es inválido',
  format('insert into public.custom_field_definitions (org_id, entity, key, label, type, options) values (%L, ''customer'', ''tx'', ''Tx'', ''text'', ''["a"]'')', t.id('orgA')), '23514');
select t.throws('la clave debe ser un identificador seguro',
  format('insert into public.custom_field_definitions (org_id, entity, key, label, type) values (%L, ''customer'', ''Mala Clave!'', ''X'', ''text'')', t.id('orgA')), '23514');
select t.throws('no se puede cambiar la clave (privilegio de columna)',
  format('update public.custom_field_definitions set key = ''otra'' where org_id = %L', t.id('orgA')), '42501');
select t.ok('sí se puede cambiar la etiqueta',
  t.affected($q$update public.custom_field_definitions set label = 'Notas internas' where org_id = {orgA} and key = 'notas'$q$) = 1);
select t.reset();
select t.throws('ni el dueño puede cambiar el tipo (trigger)',
  format('update public.custom_field_definitions set type = ''number'' where org_id = %L and key = ''notas''', t.id('orgA')), '23514');

select t.as_user(:S1);
select t.ok('un vendedor ve las definiciones de su organización', (select count(*) from public.custom_field_definitions) = 10);
select t.throws('un vendedor no puede crearlas',
  format('insert into public.custom_field_definitions (org_id, entity, key, label, type) values (%L, ''customer'', ''zz'', ''Z'', ''text'')', t.id('orgA')), '42501');
select t.reset();
select t.as_user(:B);
select t.ok('otra organización no ve las definiciones', (select count(*) from public.custom_field_definitions) = 0);
select t.throws('ni puede crearlas en otra organización',
  format('insert into public.custom_field_definitions (org_id, entity, key, label, type) values (%L, ''customer'', ''zz'', ''Z'', ''text'')', t.id('orgA')), '42501');
select t.reset();

-- Validación por tipo (válidos)
select t.ok('valores válidos de todos los tipos', (select true from (select app.validate_custom_fields(t.id('orgA'), 'customer', $j${
  "notas":"hola","edad":33,"nacio":"1990-02-28","nivel":"oro","gustos":["a","c"],"vip":true,
  "ingreso":1500000.5,"web":"https://acme.co/x","tel2":"+57 300 111 2233","mail2":"a@b.co"}$j$::jsonb)) x));
select t.ok('null limpia un valor', (select true from (select app.validate_custom_fields(t.id('orgA'), 'customer', '{"edad":null}') ) x));
select t.ok('objeto vacío es válido', (select true from (select app.validate_custom_fields(t.id('orgA'), 'customer', '{}')) x));

-- Inválidos
select t.throws('texto con número', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"notas":5}'), '22023');
select t.throws('número con texto', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"edad":"33"}'), '22023');
select t.throws('fecha con formato incorrecto', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"nacio":"28/02/1990"}'), '22023');
select t.throws('fecha inexistente', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"nacio":"2023-02-31"}'), '22023');
select t.throws('select fuera de opciones', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"nivel":"bronce"}'), '22023');
select t.throws('multi_select con opción no permitida', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"gustos":["a","z"]}'), '22023');
select t.throws('multi_select que no es lista', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"gustos":"a"}'), '22023');
select t.throws('boolean con texto', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"vip":"si"}'), '22023');
select t.throws('url sin http(s)', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"web":"javascript:alert(1)"}'), '22023');
select t.throws('email inválido', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"mail2":"no-es-email"}'), '22023');
select t.throws('teléfono con letras', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"tel2":"abc"}'), '22023');
select t.throws('clave desconocida', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '{"nope":1}'), '22023');
select t.throws('entidad equivocada (lead no tiene campos definidos)', format('select app.validate_custom_fields(%L, ''lead'', %L)', t.id('orgA'), '{"notas":"x"}'), '22023');
select t.throws('las definiciones de otra organización no aplican', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgB'), '{"notas":"x"}'), '22023');
select t.throws('no es un objeto', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), '[1]'), '22023');
select t.throws('demasiado grande', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), jsonb_build_object('notas', repeat('x', 9000))::text), '22023');
select t.throws('texto demasiado largo', format('select app.validate_custom_fields(%L, ''customer'', %L)', t.id('orgA'), jsonb_build_object('notas', repeat('x', 501))::text), '22023');

-- Un campo archivado sigue siendo válido para datos ya guardados
select t.as_user(:A);
select t.ok('archivar una definición', t.affected($q$update public.custom_field_definitions set archived_at = now() where org_id = {orgA} and key = 'notas'$q$) = 1);
select t.reset();
select t.ok('las claves archivadas siguen siendo conocidas (no se rompen datos históricos)',
  (select true from (select app.validate_custom_fields(t.id('orgA'), 'customer', '{"notas":"viejo"}')) x));

rollback;
\echo ✔ CAMPOS PERSONALIZADOS: TODAS LAS PRUEBAS PASARON
