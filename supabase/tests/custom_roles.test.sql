-- Pruebas de 0027: Roles personalizados. Los roles de sistema (org_id nulo) nunca se tocan.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-c909-0000-0000-00000000000a'''
\set S1 '''51000000-c909-0000-0000-000000000001'''
\set V1 '''6a000000-c909-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@rl.test'), (:S1, 's1@rl.test'), (:V1, 'v1@rl.test');
select t.as_user(:A); select t.save('org', public.create_organization('Roles Test', 'roles-test'));
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :S1::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :V1::uuid, r.id from public.roles r where r.key = 'viewer' and r.org_id is null;
select t.reset();

-- ---- Crear un rol personalizado (solo roles:manage: super_admin/admin, no un vendedor)
select t.as_user(:S1);
select t.throws('un vendedor NO puede crear un rol (no tiene roles:manage)',
  format('select public.create_custom_role(%L, ''vendedor_junior'', ''Vendedor junior'', null, ''[{"key":"leads:read","scope":"own"}]''::jsonb)', t.id('org')), '42501');
select t.reset();

select t.as_user(:A); -- super_admin: tiene roles:manage (todo lo tiene)
select t.save('role', public.create_custom_role(t.id('org'), 'vendedor_junior', 'Vendedor junior', 'Solo lectura de sus propios leads',
  '[{"key":"leads:read","scope":"own"},{"key":"tasks:read","scope":"own"},{"key":"tasks:create","scope":"own"}]'::jsonb));
select t.reset();
select t.ok('crea el rol con sus 3 permisos', (select count(*) = 3 from public.role_permissions where role_id = t.id('role')));
select t.ok('el rol queda atado a esta organización (no es de sistema)', (select org_id = t.id('org') from public.roles where id = t.id('role')));

select t.as_user(:A);
select t.throws('una clave con mayúsculas o símbolos se rechaza', format('select public.create_custom_role(%L, ''Vendedor Junior'', ''X'', null, ''[]''::jsonb)', t.id('org')), '22023');
select t.throws('una clave repetida en la misma organización se rechaza', format('select public.create_custom_role(%L, ''vendedor_junior'', ''Otro'', null, ''[]''::jsonb)', t.id('org')), '23505');
select t.reset();

-- ---- Asignar el rol nuevo a una persona: no necesita nada nuevo (changeRole ya acepta cualquier rol de la organización)
select t.as_user(:A);
update public.memberships set role_id = t.id('role') where org_id = t.id('org') and user_id = :V1::uuid;
select t.reset();
select t.ok('V1 ahora tiene el rol personalizado', (select role_id = t.id('role') from public.memberships where org_id = t.id('org') and user_id = :V1::uuid));
select t.as_user(:V1); select t.ok('con el rol nuevo, V1 puede leer SUS PROPIOS leads (own)', app.has_permission(t.id('org'), 'leads:read')); select t.reset();
select t.as_user(:V1); select t.ok('pero no puede ver reportes (nunca se le dio ese permiso)', not app.has_permission(t.id('org'), 'reports:read')); select t.reset();

-- ---- Editar los permisos de un rol personalizado (reemplaza el conjunto completo)
select t.as_user(:A);
select public.set_custom_role_permissions(t.id('role'), '[{"key":"leads:read","scope":"team"},{"key":"opportunities:read","scope":"own"}]'::jsonb);
select t.reset();
select t.ok('quedan exactamente los 2 permisos nuevos (no se acumulan)', (select count(*) = 2 from public.role_permissions where role_id = t.id('role')));
select t.ok('el alcance de leads:read cambió a «team»', (select scope = 'team' from public.role_permissions where role_id = t.id('role') and permission_key = 'leads:read'));

-- ---- Renombrar
select t.as_user(:A); select public.rename_custom_role(t.id('role'), 'Vendedor Junior (Editado)', 'Nueva descripción'); select t.reset();
select t.ok('el nombre y la descripción se actualizaron', (select name = 'Vendedor Junior (Editado)' and description = 'Nueva descripción' from public.roles where id = t.id('role')));

-- ---- No se puede borrar un rol que alguien tiene asignado
select t.as_user(:A);
select t.throws('no se puede borrar un rol en uso', format('select public.delete_custom_role(%L)', t.id('role')), '23514');
select t.reset();

-- ---- Sí se puede borrar uno que ya nadie tiene
select t.as_user(:A);
update public.memberships set role_id = (select id from public.roles where key = 'viewer' and org_id is null) where org_id = t.id('org') and user_id = :V1::uuid;
select public.delete_custom_role(t.id('role'));
select t.reset();
select t.ok('el rol ya no existe', (select count(*) = 0 from public.roles where id = t.id('role')));

-- ---- Los roles de SISTEMA nunca se pueden tocar con estas funciones
select t.as_user(:A);
select t.save('sysrole', (select id from public.roles where key = 'sales_agent' and org_id is null));
select t.throws('no se puede renombrar un rol de sistema', format('select public.rename_custom_role(%L, ''Hackeado'', null)', t.id('sysrole')), '22023');
select t.throws('no se puede cambiar los permisos de un rol de sistema', format('select public.set_custom_role_permissions(%L, ''[]''::jsonb)', t.id('sysrole')), '22023');
select t.throws('no se puede borrar un rol de sistema', format('select public.delete_custom_role(%L)', t.id('sysrole')), '22023');
select t.reset();

-- ---- Un rol de una organización no se puede tocar desde otra
select t.as_user(:A); select t.save('org2', public.create_organization('Roles Test Dos', 'roles-test-dos')); select t.reset();
select t.as_user(:A); select t.save('role2', public.create_custom_role(t.id('org2'), 'otro_rol', 'Otro rol', null, '[]'::jsonb)); select t.reset();
select t.as_user(:S1); -- S1 no pertenece a org2, y ni siquiera tiene roles:manage en la suya
select t.throws('alguien sin roles:manage en esa organización no puede tocar el rol de otra empresa', format('select public.rename_custom_role(%L, ''X'', null)', t.id('role2')), '42501'); select t.reset();

rollback;
\echo ✔ ROLES PERSONALIZADOS: TODAS LAS PRUEBAS PASARON
