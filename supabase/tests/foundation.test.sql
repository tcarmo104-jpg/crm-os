-- Pruebas de la Fase 1: aislamiento multi-tenant, RBAC, auditoría y eventos.
-- Todo corre dentro de una transacción que termina en ROLLBACK.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C  '''cccccccc-0000-0000-0000-00000000000c'''
\set D  '''dddddddd-0000-0000-0000-00000000000d'''
\set E  '''eeeeeeee-0000-0000-0000-00000000000e'''
\set T1 '''11111111-0000-0000-0000-000000000001'''
\set T2 '''22222222-0000-0000-0000-000000000002'''
\set TB '''33333333-0000-0000-0000-000000000003'''

begin;

-- ---------------------------------------------------------------------------
-- Helpers de prueba
-- ---------------------------------------------------------------------------
\i supabase/tests/support/test_helpers.sql

-- ---------------------------------------------------------------------------
-- Setup
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  (:A, 'a@acme.test', '{"full_name":"Ana"}'),
  (:B, 'b@beta.test', '{"full_name":"Bruno"}'),
  (:C, 'c@acme.test', '{"full_name":"Carlos"}'),
  (:D, 'd@acme.test', '{"full_name":"Diana"}'),
  (:E, 'e@acme.test', '{"full_name":"Elena"}');

insert into t.ctx values ('A', :A), ('B', :B), ('C', :C), ('D', :D), ('E', :E), ('T1', :T1), ('T2', :T2), ('TB', :TB);

select t.ok('el trigger crea un perfil por usuario', (select count(*) from public.profiles) = 5);

select t.as_user(:A);
select t.save('orgA', public.create_organization('Acme', 'acme'));
select t.reset();
select t.as_user(:B);
select t.save('orgB', public.create_organization('Beta', 'beta'));
select t.reset();

-- ---------------------------------------------------------------------------
-- 1. Aislamiento entre organizaciones
-- ---------------------------------------------------------------------------
select t.as_user(:A);
select t.ok('A ve exactamente 1 organización', (select count(*) from public.organizations) = 1);
select t.ok('A no ve la organización de B', (select count(*) from public.organizations where id = t.id('orgB')) = 0);
select t.ok('A no puede actualizar la organización de B (0 filas)',
  t.affected($q$update public.organizations set name = 'HACKED' where id = {orgB}$q$) = 0);
select t.throws('A no puede cambiar el slug (privilegio de columna)',
  format('update public.organizations set slug = %L where id = %L', 'nuevo-slug', t.id('orgA')), '42501');
select t.ok('A sí puede editar el nombre de su organización',
  t.affected($q$update public.organizations set name = 'Acme SAS' where id = {orgA}$q$) = 1);
select t.throws('slug reservado', $$select public.create_organization('X Corp', 'admin')$$, '23514');
select t.throws('slug inválido', $$select public.create_organization('X Corp', 'A B')$$, '23514');
select t.throws('INSERT directo en organizations denegado',
  $$insert into public.organizations (name, slug) values ('Directa', 'directa')$$, '42501');
select t.reset();

select t.as_user(:B);
select t.ok('el nombre de la org de B no fue alterado',
  (select name from public.organizations where id = t.id('orgB')) = 'Beta');
select t.reset();

select t.as_anon();
select t.throws('anon no puede leer organizations', $$select * from public.organizations$$, '42501');
select t.throws('anon no puede ejecutar create_organization', $$select public.create_organization('Anon', 'anon-co')$$, '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- 2. Equipos
-- ---------------------------------------------------------------------------
select t.as_user(:A);
insert into public.teams (id, org_id, name) values (:T1, t.id('orgA'), 'Ventas Bogotá');
insert into public.teams (id, org_id, name) values (:T2, t.id('orgA'), 'Ventas Medellín');
select t.throws('A no puede crear equipos en la org de B',
  format('insert into public.teams (org_id, name) values (%L, %L)', t.id('orgB'), 'Intruso'), '42501');
select t.reset();

select t.as_user(:B);
insert into public.teams (id, org_id, name) values (:TB, t.id('orgB'), 'Equipo Beta');
select t.ok('B solo ve su equipo', (select count(*) from public.teams) = 1);
select t.reset();

-- ---------------------------------------------------------------------------
-- 3. Membresías y RBAC
-- ---------------------------------------------------------------------------
select t.as_user(:A);
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), :C, id, null from public.roles where key = 'sales_agent'      and org_id is null;
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), :D, id, null from public.roles where key = 'admin'            and org_id is null;
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), :E, id, :T1 from public.roles where key = 'sales_manager'     and org_id is null;

select t.throws('FK compuesta: no se puede usar un equipo de otra organización',
  format('insert into public.memberships (org_id, user_id, role_id, team_id)
          select %L, %L, id, %L from public.roles where key = ''sales_agent'' and org_id is null',
         t.id('orgA'), :B, :TB), '23503');
select t.reset();

-- Vendedor (C)
select t.as_user(:C);
select t.ok('C (vendedor) ve los equipos de su organización', (select count(*) from public.teams) = 2);
select t.throws('C no puede crear equipos',
  format('insert into public.teams (org_id, name) values (%L, %L)', t.id('orgA'), 'X'), '42501');
select t.throws('C no puede agregar miembros',
  format('insert into public.memberships (org_id, user_id, role_id)
          select %L, %L, id from public.roles where key = ''viewer'' and org_id is null', t.id('orgA'), :B), '42501');
select t.ok('C no puede auto-escalarse a super_admin (0 filas)',
  t.affected($q$update public.memberships
     set role_id = (select id from public.roles where key = 'super_admin' and org_id is null)
   where user_id = {C}$q$) = 0);
select t.ok('C sigue siendo sales_agent',
  (select r.key from public.memberships m join public.roles r on r.id = m.role_id where m.user_id = :C) = 'sales_agent');
select t.ok('C no puede leer la auditoría', (select count(*) from public.audit_logs) = 0);
select t.ok('C ve perfiles solo de su organización (A, C, D, E)', (select count(*) from public.profiles) = 4);
select t.ok('C no ve el perfil de B', (select count(*) from public.profiles where id = :B) = 0);
select t.reset();

-- Administrador (D)
select t.as_user(:D);
select t.throws('D (admin) no puede otorgar super_admin',
  format('insert into public.memberships (org_id, user_id, role_id)
          select %L, %L, id from public.roles where key = ''super_admin'' and org_id is null', t.id('orgA'), :B), '42501');
select t.throws('D (admin) no puede eliminar al super_admin',
  format('delete from public.memberships where org_id = %L and user_id = %L', t.id('orgA'), :A), '42501');
select t.ok('D sí puede editar la región de C',
  t.affected($q$update public.memberships set region = 'Bogotá' where user_id = {C} and org_id = {orgA}$q$) = 1);
select t.ok('D puede leer la auditoría de su organización', (select count(*) from public.audit_logs) > 0);
select t.reset();

-- ---------------------------------------------------------------------------
-- 4. Alcance por registro (own / team / org)
-- ---------------------------------------------------------------------------
select t.as_user(:C);
select t.ok('agent: registro propio permitido',   app.can_access_row(t.id('orgA'), 'leads:read', :C, null));
select t.ok('agent: registro ajeno denegado',    not app.can_access_row(t.id('orgA'), 'leads:read', :A, null));
select t.ok('agent: sin permiso de borrado',     not app.can_access_row(t.id('orgA'), 'leads:delete', :C, null));
select t.ok('agent: sin acceso a otra organización', not app.can_access_row(t.id('orgB'), 'leads:read', :C, null));
select t.reset();

select t.as_user(:E);
select t.ok('sales_manager: alcance = team', app.permission_scope(t.id('orgA'), 'leads:read') = 'team');
select t.ok('sales_manager: registro de su equipo permitido', app.can_access_row(t.id('orgA'), 'leads:read', :C, :T1));
select t.ok('sales_manager: registro de otro equipo denegado', not app.can_access_row(t.id('orgA'), 'leads:read', :C, :T2));
select t.ok('sales_manager: catálogo de productos a nivel org', app.has_permission(t.id('orgA'), 'products:read'));
select t.reset();

select t.as_user(:A);
select t.ok('super_admin: acceso org a registros de cualquier equipo', app.can_access_row(t.id('orgA'), 'leads:read', :C, :T2));
select t.reset();

select t.as_user(:B);
select t.ok('B no es miembro de la org A', not app.is_member(t.id('orgA')));
select t.ok('B no tiene permisos en la org A', not app.can_access_row(t.id('orgA'), 'leads:read', :B, null));
select t.reset();

-- ---------------------------------------------------------------------------
-- 5. Auditoría
-- ---------------------------------------------------------------------------
select t.as_user(:A);
update public.teams set name = 'Costa' where id = :T2;
select t.reset();

select t.ok('auditoría registra INSERT de equipos con su actor',
  (select count(*) from public.audit_logs
    where action = 'teams.insert' and actor_id = :A and org_id = t.id('orgA')) = 2);
select t.ok('auditoría UPDATE guarda solo las columnas cambiadas (antes/después)',
  (select old_values = '{"name":"Ventas Medellín"}'::jsonb and new_values = '{"name":"Costa"}'::jsonb
     from public.audit_logs where action = 'teams.update' and entity_id = :T2));
select t.ok('auditoría registra los cambios de membresía',
  (select count(*) from public.audit_logs where action = 'memberships.insert' and org_id = t.id('orgA')) >= 4);

select t.as_user(:A);
select t.ok('A no ve auditoría de otra organización',
  (select count(*) from public.audit_logs where org_id = t.id('orgB')) = 0);
select t.throws('A no puede modificar la auditoría', $$update public.audit_logs set action = 'x'$$, '42501');
select t.throws('A no puede borrar la auditoría', $$delete from public.audit_logs$$, '42501');
select t.reset();
select t.throws('ni siquiera el dueño puede UPDATE en audit_logs (trigger)', $$update public.audit_logs set action = 'x'$$, '42501');
select t.throws('ni siquiera el dueño puede DELETE en audit_logs (trigger)', $$delete from public.audit_logs$$, '42501');
select t.throws('ni siquiera el dueño puede TRUNCATE audit_logs (trigger)', $$truncate public.audit_logs$$, '42501');

-- ---------------------------------------------------------------------------
-- 6. Propiedad de la organización
-- ---------------------------------------------------------------------------
select t.as_user(:A);
select t.throws('el último super_admin no puede degradarse',
  format('update public.memberships set role_id = (select id from public.roles where key = ''admin'' and org_id is null)
           where user_id = %L and org_id = %L', :A, t.id('orgA')), '23514');
select t.ok('A promueve a D a super_admin',
  t.affected($q$update public.memberships
     set role_id = (select id from public.roles where key = 'super_admin' and org_id is null)
   where user_id = {D} and org_id = {orgA}$q$) = 1);
select t.ok('ahora A puede degradarse a admin',
  t.affected($q$update public.memberships
     set role_id = (select id from public.roles where key = 'admin' and org_id is null)
   where user_id = {A} and org_id = {orgA}$q$) = 1);
select t.throws('A (ya admin) no puede quitar a un super_admin',
  format('delete from public.memberships where user_id = %L and org_id = %L', :D, t.id('orgA')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- 7. Event stream (outbox)
-- ---------------------------------------------------------------------------
select t.as_user(:A);
select t.throws('un usuario no puede leer domain_events', $$select * from public.domain_events$$, '42501');
select t.throws('un usuario no puede emitir eventos',
  format('select app.emit_event(%L, %L, %L, null)', t.id('orgA'), 'fake.event', 'x'), '42501');
select t.throws('un usuario no puede reclamar eventos', $$select * from app.claim_events(10)$$, '42501');
select t.reset();

select t.ok('create_organization emitió organization.created (x2)',
  (select count(*) from public.domain_events where type = 'organization.created') = 2);

select t.as_service();
select t.ok('el worker reclama los eventos pendientes', (select count(*) from app.claim_events(10)) = 2);
select t.ok('un segundo worker no recibe los ya reclamados (SKIP LOCKED/lock)', (select count(*) from app.claim_events(10)) = 0);
select t.reset();

select t.ok('reclamar incrementa attempts', (select min(attempts) from public.domain_events) = 1);

select t.as_service();
select app.complete_event((select id from public.domain_events where org_id = t.id('orgA') limit 1));
select app.fail_event((select id from public.domain_events where org_id = t.id('orgB') limit 1), 'boom');
select t.reset();

select t.ok('complete_event marca processed_at',
  (select processed_at is not null from public.domain_events where org_id = t.id('orgA')));
select t.ok('fail_event guarda el error y aplica backoff',
  (select last_error = 'boom' and locked_until > now() from public.domain_events where org_id = t.id('orgB')));
select t.ok('fail_event con intentos por debajo del máximo NO va a dead-letter',
  (select dead_at is null from public.domain_events where org_id = t.id('orgB')));
select t.as_service();
select app.fail_event((select id from public.domain_events where org_id = t.id('orgB')), 'boom', 1);
select t.reset();
select t.ok('dead-letter tras superar el máximo',
  (select dead_at is not null from public.domain_events where org_id = t.id('orgB')));

-- ---------------------------------------------------------------------------
-- 7b. Visibilidad de clientes (regla de negocio)
-- ---------------------------------------------------------------------------
select t.ok('customers:read a nivel org SOLO para super_admin, admin y manager',
  (select array_agg(r.key order by r.key) from public.role_permissions rp
     join public.roles r on r.id = rp.role_id
    where r.org_id is null and rp.permission_key = 'customers:read' and rp.scope = 'org')
  = array['admin','manager','super_admin']);
select t.ok('customers:update a nivel org SOLO para super_admin, admin y manager',
  (select array_agg(r.key order by r.key) from public.role_permissions rp
     join public.roles r on r.id = rp.role_id
    where r.org_id is null and rp.permission_key = 'customers:update' and rp.scope = 'org')
  = array['admin','manager','super_admin']);
select t.ok('customers:read a nivel team SOLO para sales_manager',
  (select array_agg(r.key order by r.key) from public.role_permissions rp
     join public.roles r on r.id = rp.role_id
    where r.org_id is null and rp.permission_key = 'customers:read' and rp.scope = 'team')
  = array['sales_manager']);
select t.ok('el resto de roles ve solo clientes propios (own)',
  (select array_agg(r.key order by r.key) from public.role_permissions rp
     join public.roles r on r.id = rp.role_id
    where r.org_id is null and rp.permission_key = 'customers:read' and rp.scope = 'own')
  = array['analyst','customer_service','marketing','sales_agent','viewer']);

select t.as_user(:C);
select t.ok('vendedor: ve su propio cliente',     app.can_access_row(t.id('orgA'), 'customers:read', :C, null));
select t.ok('vendedor: NO ve el cliente de otro vendedor', not app.can_access_row(t.id('orgA'), 'customers:read', :E, null));
select t.ok('vendedor: NO ve clientes ni siquiera del equipo de otro', not app.can_access_row(t.id('orgA'), 'customers:read', :E, :T1));
select t.reset();

select t.as_user(:E);
select t.ok('sales_manager: ve clientes de su equipo',   app.can_access_row(t.id('orgA'), 'customers:read', :C, :T1));
select t.ok('sales_manager: NO ve clientes de otro equipo', not app.can_access_row(t.id('orgA'), 'customers:read', :C, :T2));
select t.reset();

select t.as_user(:A);
select t.ok('admin: ve los clientes de cualquier vendedor y equipo', app.can_access_row(t.id('orgA'), 'customers:read', :C, :T2));
select t.reset();

-- ---------------------------------------------------------------------------
-- 8. Guardas estructurales (evitan regresiones futuras)
-- ---------------------------------------------------------------------------
select t.ok('TODAS las tablas de public tienen RLS activado',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('anon no tiene privilegios sobre ninguna tabla de public',
  (select count(*) from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public') = 0);
select t.ok('authenticated no puede INSERT en domain_events/audit_logs/organizations',
  not has_table_privilege('authenticated', 'public.domain_events', 'INSERT')
  and not has_table_privilege('authenticated', 'public.audit_logs', 'INSERT')
  and not has_table_privilege('authenticated', 'public.organizations', 'INSERT'));
select t.ok('anon/authenticated no pueden ejecutar funciones internas de app',
  not has_function_privilege('authenticated', 'app.emit_event(uuid,text,text,uuid,jsonb,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'app.is_member(uuid)', 'EXECUTE'));

rollback;
\echo ✔ TODAS LAS PRUEBAS PASARON
