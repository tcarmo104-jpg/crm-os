-- Pruebas de invitaciones y de la API para workers.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set C '''cccccccc-0000-0000-0000-00000000000c'''
\set X '''99999999-0000-0000-0000-000000000009'''
\set U '''88888888-0000-0000-0000-000000000008'''
\set T1 '''11111111-0000-0000-0000-000000000001'''
\set TB '''33333333-0000-0000-0000-000000000003'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email, email_confirmed_at) values
  (:A, 'a@acme.test', now()),
  (:B, 'b@beta.test', now()),
  (:C, 'c@acme.test', now()),
  (:X, 'x@other.test', now()),
  (:U, 'u@acme.test', null);          -- email SIN verificar
insert into t.ctx values ('A', :A), ('B', :B), ('C', :C), ('X', :X), ('U', :U), ('T1', :T1), ('TB', :TB);

select t.as_user(:A); select t.save('orgA', public.create_organization('Acme', 'acme'));
insert into public.teams (id, org_id, name) values (:T1, t.id('orgA'), 'Ventas');
select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Beta', 'beta'));
insert into public.teams (id, org_id, name) values (:TB, t.id('orgB'), 'Equipo Beta');
select t.reset();

-- Token en una tabla de contexto de prueba (solo para el test)
create table t.tokens (k text primary key, v text);
grant all on t.tokens to public;

-- ---------------------------------------------------------------------------
-- Creación
-- ---------------------------------------------------------------------------
select t.as_user(:A);
insert into t.tokens select 'c', public.create_invitation(t.id('orgA'), '  C@Acme.TEST ', 'sales_agent', :T1);
select t.ok('el token tiene 64 caracteres', (select length(v) = 64 from t.tokens where k = 'c'));
select t.ok('el email se normaliza a minúsculas',
  (select email from public.invitations where org_id = t.id('orgA')) = 'c@acme.test');
select t.throws('no se puede leer token_hash (privilegio de columna)',
  $$select token_hash from public.invitations$$, '42501');
select t.throws('no se puede invitar como super_admin',
  format('select public.create_invitation(%L, %L, %L)', t.id('orgA'), 'z@acme.test', 'super_admin'), '42501');
select t.throws('rol inexistente', format('select public.create_invitation(%L, %L, %L)', t.id('orgA'), 'z@acme.test', 'no_existe'), '22023');
select t.throws('A no puede invitar a la organización de B',
  format('select public.create_invitation(%L, %L, %L)', t.id('orgB'), 'z@beta.test', 'viewer'), '42501');
select t.throws('el equipo debe ser de la misma organización (FK compuesta)',
  format('select public.create_invitation(%L, %L, %L, %L)', t.id('orgA'), 'q@acme.test', 'viewer', :TB), '23503');
select t.throws('INSERT directo en invitations denegado',
  format('insert into public.invitations (org_id, email, role_id, token_hash)
          select %L, ''h@acme.test'', id, ''x'' from public.roles where key = ''viewer'' and org_id is null', t.id('orgA')), '42501');
select t.reset();

select t.ok('el token NO se guarda en claro',
  (select count(*) from public.invitations i join t.tokens k on k.k = 'c' where i.token_hash = k.v) = 0);
select t.ok('se guarda su SHA-256',
  (select count(*) from public.invitations i join t.tokens k on k.k = 'c'
    where i.token_hash = encode(sha256(convert_to(k.v, 'UTF8')), 'hex')) = 1);

select t.as_user(:C);
select t.ok('el invitado aún no ve invitaciones (no es admin)', (select count(*) from public.invitations) = 0);
select t.reset();

-- ---------------------------------------------------------------------------
-- Vista previa
-- ---------------------------------------------------------------------------
select t.as_user(:C);
select t.ok('get_invitation muestra organización, rol y estado',
  (select org_name = 'Acme' and role_name = 'Vendedor' and status = 'pending'
     from public.get_invitation((select v from t.tokens where k = 'c'))));
select t.ok('un token inválido no devuelve nada', (select count(*) from public.get_invitation('nope')) = 0);
select t.reset();
select t.as_anon();
select t.throws('anon no puede llamar get_invitation', $$select * from public.get_invitation('x')$$, '42501');
select t.throws('anon no puede llamar accept_invitation', $$select public.accept_invitation('x')$$, '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Aceptación: validaciones de identidad
-- ---------------------------------------------------------------------------
select t.as_user(:X);
select t.throws('un usuario con otro email no puede aceptar',
  format('select public.accept_invitation(%L)', (select v from t.tokens where k = 'c')), '42501');
select t.throws('token inexistente', $$select public.accept_invitation('nope')$$, 'P0002');
select t.reset();

select t.as_user(:A);
insert into t.tokens select 'u', public.create_invitation(t.id('orgA'), 'u@acme.test', 'viewer');
select t.reset();
select t.as_user(:U);
select t.throws('email sin verificar no puede aceptar',
  format('select public.accept_invitation(%L)', (select v from t.tokens where k = 'u')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Aceptación correcta
-- ---------------------------------------------------------------------------
select t.as_user(:C);
select t.ok('C acepta y recibe el id de la organización',
  public.accept_invitation((select v from t.tokens where k = 'c')) = t.id('orgA'));
select t.ok('C es miembro con el rol y equipo de la invitación',
  (select r.key = 'sales_agent' and m.team_id = :T1 and m.status = 'active'
     from public.memberships m join public.roles r on r.id = m.role_id
    where m.user_id = :C and m.org_id = t.id('orgA')));
select t.throws('la invitación no puede reutilizarse',
  format('select public.accept_invitation(%L)', (select v from t.tokens where k = 'c')), '55000');
select t.throws('un vendedor no puede invitar (sin users:manage)',
  format('select public.create_invitation(%L, %L, %L)', t.id('orgA'), 'w@acme.test', 'viewer'), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Reglas al invitar / revocar / expirar
-- ---------------------------------------------------------------------------
select t.as_user(:A);
select t.throws('no se invita a quien ya es miembro',
  format('select public.create_invitation(%L, %L, %L)', t.id('orgA'), 'c@acme.test', 'viewer'), '23505');

insert into t.tokens select 'd1', public.create_invitation(t.id('orgA'), 'd@acme.test', 'admin');
insert into t.tokens select 'd2', public.create_invitation(t.id('orgA'), 'd@acme.test', 'admin');
select t.ok('reinvitar deja una sola invitación pendiente para ese email',
  (select count(*) from public.invitations
    where org_id = t.id('orgA') and email = 'd@acme.test' and accepted_at is null and revoked_at is null) = 1);
select t.reset();

insert into auth.users (id, email) values ('77777777-0000-0000-0000-000000000007', 'd@acme.test');
select t.as_user('77777777-0000-0000-0000-000000000007');
select t.throws('la invitación anterior quedó invalidada',
  format('select public.accept_invitation(%L)', (select v from t.tokens where k = 'd1')), '55000');
select t.reset();

-- revocar
select t.as_user(:C);
select t.throws('un vendedor no puede revocar invitaciones',
  format('select public.revoke_invitation(%L)', (select id from public.invitations where email = 'd@acme.test' and revoked_at is null limit 1)), '42501');
select t.reset();
select t.as_user(:B);
select t.throws('B no puede revocar invitaciones de otra organización',
  format('select public.revoke_invitation(%L)', (select id from public.invitations where email = 'd@acme.test' and revoked_at is null limit 1)), '42501');
select t.reset();
select t.as_user(:A);
select public.revoke_invitation((select id from public.invitations where email = 'd@acme.test' and revoked_at is null limit 1));
select t.reset();
select t.as_user('77777777-0000-0000-0000-000000000007');
select t.throws('una invitación revocada no se puede aceptar',
  format('select public.accept_invitation(%L)', (select v from t.tokens where k = 'd2')), '55000');
select t.reset();

-- expirar
select t.as_user(:A);
insert into t.tokens select 'e', public.create_invitation(t.id('orgA'), 'e@acme.test', 'viewer');
select t.reset();
update public.invitations set expires_at = now() - interval '1 day' where email = 'e@acme.test';
insert into auth.users (id, email) values ('66666666-0000-0000-0000-000000000006', 'e@acme.test');
select t.as_user('66666666-0000-0000-0000-000000000006');
select t.throws('una invitación expirada no se puede aceptar',
  format('select public.accept_invitation(%L)', (select v from t.tokens where k = 'e')), '55000');
select t.ok('get_invitation informa el estado expirado',
  (select status from public.get_invitation((select v from t.tokens where k = 'e'))) = 'expired');
select t.reset();

-- ---------------------------------------------------------------------------
-- Auditoría y eventos
-- ---------------------------------------------------------------------------
select t.ok('la auditoría registra invitaciones', (select count(*) from public.audit_logs where entity_type = 'invitations') > 0);
select t.ok('la auditoría NUNCA contiene token_hash',
  (select count(*) from public.audit_logs
    where entity_type = 'invitations' and (new_values ? 'token_hash' or old_values ? 'token_hash')) = 0);
select t.ok('se emiten invitation.created e invitation.accepted',
  (select count(distinct type) from public.domain_events where type in ('invitation.created', 'invitation.accepted')) = 2);

-- ---------------------------------------------------------------------------
-- API para workers: solo service_role
-- ---------------------------------------------------------------------------
select t.as_user(:A);
select t.throws('authenticated no puede reclamar eventos vía RPC público', $$select * from public.worker_claim_events(5)$$, '42501');
select t.reset();
select t.as_anon();
select t.throws('anon no puede reclamar eventos vía RPC público', $$select * from public.worker_claim_events(5)$$, '42501');
select t.reset();
select t.as_service();
select t.ok('service_role reclama eventos vía RPC público', (select count(*) from public.worker_claim_events(50)) > 0);
select t.ok('segundo reclamo inmediato no devuelve los ya bloqueados', (select count(*) from public.worker_claim_events(50)) = 0);
select t.reset();

select t.ok('TODAS las tablas de public siguen con RLS activado',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('anon sigue sin privilegios sobre tablas de public',
  (select count(*) from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public') = 0);

rollback;
\echo ✔ INVITACIONES: TODAS LAS PRUEBAS PASARON
