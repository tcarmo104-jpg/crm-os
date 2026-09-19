-- Pruebas de Customer 360: visibilidad, resolución de identidad, fusión, "no contactar".
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set S1 '''51000000-0000-0000-0000-000000000001'''
\set S2 '''52000000-0000-0000-0000-000000000002'''
\set M  '''4d000000-0000-0000-0000-00000000000d'''
\set V  '''56000000-0000-0000-0000-000000000006'''
\set E  '''e0000000-0000-0000-0000-00000000000e'''
\set T1 '''11111111-0000-0000-0000-000000000001'''
\set T2 '''22222222-0000-0000-0000-000000000002'''

begin;
\i supabase/tests/support/test_helpers.sql
create table t.res (k text primary key, v jsonb);
grant all on t.res to public;

insert into auth.users (id, email) values
  (:A, 'a@acme.test'), (:B, 'b@beta.test'), (:S1, 's1@acme.test'), (:S2, 's2@acme.test'),
  (:M, 'm@acme.test'), (:V, 'v@acme.test'), (:E, 'e@acme.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('S2', :S2), ('M', :M), ('V', :V), ('E', :E), ('T1', :T1), ('T2', :T2);

select t.as_user(:A);
select t.save('orgA', public.create_organization('Acme', 'acme'));
insert into public.teams (id, org_id, name) values (:T1, t.id('orgA'), 'Bogotá'), (:T2, t.id('orgA'), 'Medellín');
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), u.uid, r.id, u.team
    from (values (:S1::uuid, 'sales_agent', :T1::uuid), (:S2::uuid, 'sales_agent', :T2::uuid),
                 (:M::uuid, 'manager', null::uuid), (:V::uuid, 'viewer', null::uuid),
                 (:E::uuid, 'sales_manager', :T1::uuid)) u(uid, rk, team)
    join public.roles r on r.key = u.rk and r.org_id is null;
select t.reset();
select t.as_user(:B);
select t.save('orgB', public.create_organization('Beta', 'beta'));
select t.reset();

-- ---------------------------------------------------------------------------
-- Alta manual + visibilidad
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
insert into t.res select 'c1', public.create_customer(t.id('orgA'), 'person', 'Carlos Rodríguez',
  '[{"type":"phone","value":"+573001112233"},{"type":"email","value":"carlos@x.com"}]'::jsonb,
  '{"city":"Bogotá","country":"co"}'::jsonb);
select t.ok('S1 crea un cliente nuevo', (select v ->> 'outcome' from t.res where k = 'c1') = 'created');
select t.save('cust1', (select (v ->> 'customer_id')::uuid from t.res where k = 'c1'));
select t.ok('S1 ve su cliente', (select count(*) from public.customers) = 1);
select t.reset();

-- En una sola transacción now() es constante: se fija una antigüedad real para que "el más antiguo" sea determinista.
update public.customers set first_contact_at = now() - interval '10 days' where id = t.id('cust1');

select t.ok('el propietario es quien lo creó y el equipo se deriva de su membresía',
  (select owner_id = :S1 and team_id = :T1 and country = 'CO' and name_key = 'carlos rodriguez'
     from public.customers where id = t.id('cust1')));

select t.as_user(:S2); select t.ok('S2 (otro vendedor) NO ve el cliente', (select count(*) from public.customers) = 0); select t.reset();
select t.as_user(:V);  select t.ok('viewer NO ve clientes ajenos', (select count(*) from public.customers) = 0); select t.reset();
select t.as_user(:M);  select t.ok('manager ve todos los clientes', (select count(*) from public.customers) = 1); select t.reset();
select t.as_user(:E);  select t.ok('sales_manager ve los clientes de su equipo', (select count(*) from public.customers) = 1); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no ve nada', (select count(*) from public.customers) = 0); select t.reset();
select t.as_user(:S1);
select t.ok('los identificadores siguen la visibilidad del cliente', (select count(*) from public.customer_identifiers) = 2);
select t.reset();
select t.as_user(:S2);
select t.ok('S2 no ve los identificadores', (select count(*) from public.customer_identifiers) = 0);
select t.reset();

-- ---------------------------------------------------------------------------
-- Duplicados: no se filtra información
-- ---------------------------------------------------------------------------
select t.as_user(:S2);
insert into t.res select 'dup', public.create_customer(t.id('orgA'), 'person', 'Otro Nombre',
  '[{"type":"phone","value":"+573001112233"}]'::jsonb);
select t.ok('S2 intenta crear un cliente que ya existe: respuesta genérica sin datos',
  (select v ->> 'outcome' = 'duplicate_hidden' and not (v ? 'customer_id') from t.res where k = 'dup'));
select t.ok('S2 no ve las alertas de duplicados', (select count(*) from public.identity_reviews) = 0);
select public.create_customer(t.id('orgA'), 'person', 'Otro Nombre', '[{"type":"phone","value":"+573001112233"}]'::jsonb);
select t.ok('intento oculto con un identificador existente Y uno nuevo: sigue siendo genérico',
  (public.create_customer(t.id('orgA'), 'person', 'Otro Nombre',
     '[{"type":"phone","value":"+573001112233"},{"type":"phone","value":"+573009990000"}]'::jsonb)) ->> 'outcome' = 'duplicate_hidden');
select t.reset();
select t.ok('...y el identificador nuevo NO se agrega al cliente ajeno (sin contaminación)',
  (select count(*) from public.customer_identifiers where value = '+573009990000') = 0);
select t.ok('no se creó un cliente duplicado', (select count(*) from public.customers where org_id = t.id('orgA')) = 1);
select t.ok('repetir el intento no multiplica las alertas',
  (select count(*) from public.identity_reviews where kind = 'duplicate_attempt' and status = 'pending') = 1);

select t.as_user(:M);
select t.ok('el manager SÍ ve la alerta', (select count(*) from public.identity_reviews where kind = 'duplicate_attempt') = 1);
insert into t.res select 'mex', public.create_customer(t.id('orgA'), 'person', 'Carlos R',
  '[{"type":"email","value":"carlos@x.com"}]'::jsonb);
select t.ok('manager: mismo email → cliente existente (con acceso)',
  (select v ->> 'outcome' = 'existing' and (v ->> 'customer_id')::uuid = t.id('cust1') from t.res where k = 'mex'));
select t.reset();

select t.as_user(:S1);
insert into t.res select 'own', public.create_customer(t.id('orgA'), 'person', 'Carlos Rodriguez',
  '[{"type":"phone","value":"+573001112233"}]'::jsonb);
select t.ok('el propietario que repite el alta recibe su cliente existente',
  (select v ->> 'outcome' = 'existing' and (v ->> 'customer_id')::uuid = t.id('cust1') from t.res where k = 'own'));
select t.reset();

-- Mismo nombre, sin identificador común → cliente nuevo + revisión humana
select t.as_user(:S2);
insert into t.res select 'c2', public.create_customer(t.id('orgA'), 'person', 'CARLOS  rodríguez',
  '[{"type":"phone","value":"+573002223344"}]'::jsonb);
select t.ok('mismo nombre sin identificadores comunes: se crea (nunca se fusiona solo)',
  (select v ->> 'outcome' = 'created' from t.res where k = 'c2'));
select t.save('cust2', (select (v ->> 'customer_id')::uuid from t.res where k = 'c2'));
select t.reset();
select t.ok('y queda una revisión "possible_duplicate" pendiente',
  (select count(*) from public.identity_reviews where kind = 'possible_duplicate' and status = 'pending'
     and customer_id = t.id('cust2') and candidate_id = t.id('cust1')) = 1);

-- Conflicto: el mensaje trae identificadores de dos clientes distintos
select t.as_user(:M);
insert into t.res select 'conf', public.create_customer(t.id('orgA'), 'person', 'Carlos',
  '[{"type":"phone","value":"+573001112233"},{"type":"phone","value":"+573002223344"}]'::jsonb);
select t.ok('conflicto: se devuelve el cliente más antiguo',
  (select (v ->> 'customer_id')::uuid = t.id('cust1') from t.res where k = 'conf'));
select t.ok('conflicto: se abre una revisión identifier_conflict',
  (select count(*) from public.identity_reviews where kind = 'identifier_conflict' and status = 'pending') = 1);
select t.reset();
select t.ok('alta manual NO enriquece clientes existentes',
  (select count(*) from public.customer_identifiers where customer_id = t.id('cust1')) = 2);

-- ---------------------------------------------------------------------------
-- Fusión
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.throws('un vendedor no puede fusionar clientes',
  format('select public.merge_customers(%L, %L)', t.id('cust1'), t.id('cust2')), '42501');
select t.reset();
-- cust2 pidió no ser contactado: tras la fusión el cliente principal debe conservarlo
update public.customers set do_not_contact = true, dnc_reason = 'Pidió baja' where id = t.id('cust2');
select t.as_user(:M);
select t.throws('no se puede fusionar consigo mismo',
  format('select public.merge_customers(%L, %L)', t.id('cust1'), t.id('cust1')), '22023');
insert into t.res select 'bc', public.create_customer(t.id('orgA'), 'person', 'Zed', '[{"type":"email","value":"zed@x.com"}]'::jsonb);
select t.reset();

select t.as_user(:B);
insert into t.res select 'bcust', public.create_customer(t.id('orgB'), 'person', 'Cliente Beta', '[{"type":"email","value":"beta@x.com"}]'::jsonb);
select t.save('custB', (select (v ->> 'customer_id')::uuid from t.res where k = 'bcust'));
select t.reset();
select t.as_user(:M);
select t.throws('no se puede fusionar entre organizaciones',
  format('select public.merge_customers(%L, %L)', t.id('cust1'), t.id('custB')), '42501');
select public.merge_customers(t.id('cust1'), t.id('cust2'));
select t.reset();

select t.ok('el cliente absorbido queda archivado y apunta al principal',
  (select deleted_at is not null and merged_into_id = t.id('cust1') from public.customers where id = t.id('cust2')));
select t.ok('sus identificadores pasan al cliente principal',
  (select count(*) from public.customer_identifiers where customer_id = t.id('cust1')) = 3);
select t.ok('las revisiones del par quedan resueltas; la alerta de intento sigue pendiente',
  (select count(*) filter (where status = 'pending') = 1 and count(*) filter (where status = 'merged') >= 1
     from public.identity_reviews where org_id = t.id('orgA')));
select t.ok('la fusión conserva "no contactar" del cliente absorbido (seguridad)',
  (select do_not_contact and dnc_reason = 'Pidió baja' from public.customers where id = t.id('cust1')));
update public.customers set do_not_contact = false where id = t.id('cust1');   -- se limpia para las pruebas siguientes
select t.as_user(:M);
select t.ok('el cliente archivado deja de verse', (select count(*) from public.customers where id = t.id('cust2')) = 0);
select t.reset();

-- ---------------------------------------------------------------------------
-- Propietario / equipo
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.throws('un vendedor no puede reasignar clientes',
  format('update public.customers set owner_id = %L where id = %L', :S2, t.id('cust1')), '42501');
select t.reset();
select t.as_user(:M);
select t.ok('el manager reasigna el cliente a S2',
  t.affected($q$update public.customers set owner_id = {S2} where id = {cust1}$q$) = 1);
select t.throws('el propietario debe ser miembro de la organización',
  format('update public.customers set owner_id = %L where id = %L', :B, t.id('cust1')), '23514');
select t.reset();
select t.ok('el equipo sigue al nuevo propietario',
  (select owner_id = :S2 and team_id = :T2 from public.customers where id = t.id('cust1')));
select t.as_user(:S1); select t.ok('S1 deja de ver al cliente reasignado', (select count(*) from public.customers where id = t.id('cust1')) = 0); select t.reset();
select t.as_user(:S2); select t.ok('S2 ahora lo ve', (select count(*) from public.customers where id = t.id('cust1')) = 1); select t.reset();
select t.as_user(:M);
select t.ok('el manager devuelve el cliente a S1',
  t.affected($q$update public.customers set owner_id = {S1} where id = {cust1}$q$) = 1);
select t.reset();

-- ---------------------------------------------------------------------------
-- No contactar
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.ok('el propietario activa "no contactar"',
  t.affected($q$update public.customers set do_not_contact = true, dnc_reason = 'Lo pidió' where id = {cust1}$q$) = 1);
select t.throws('no se puede escribir dnc_at directamente (privilegio de columna)',
  format('update public.customers set dnc_at = now() where id = %L', t.id('cust1')), '42501');
select t.throws('un vendedor NO puede levantar "no contactar"',
  format('update public.customers set do_not_contact = false where id = %L', t.id('cust1')), '42501');
select t.reset();
select t.ok('se registra quién y cuándo',
  (select do_not_contact and dnc_at is not null and dnc_by = :S1 and dnc_reason = 'Lo pidió'
     from public.customers where id = t.id('cust1')));
select t.as_user(:M);
select t.ok('el manager lo levanta',
  t.affected($q$update public.customers set do_not_contact = false where id = {cust1}$q$) = 1);
select t.reset();
select t.ok('se limpian dnc_at / dnc_reason',
  (select not do_not_contact and dnc_at is null and dnc_reason is null from public.customers where id = t.id('cust1')));
select t.ok('se emiten los eventos dnc_set y dnc_cleared',
  (select count(distinct type) from public.domain_events
    where customer_id = t.id('cust1') and type in ('customer.dnc_set', 'customer.dnc_cleared')) = 2);

-- ---------------------------------------------------------------------------
-- Identificadores
-- ---------------------------------------------------------------------------
select t.as_user(:S2);
insert into t.res select 'c3', public.create_customer(t.id('orgA'), 'person', 'Persona Tres', '[{"type":"phone","value":"+573004445566"}]'::jsonb);
select t.save('cust3', (select (v ->> 'customer_id')::uuid from t.res where k = 'c3'));
select t.reset();
select t.as_user(:S1);
select t.ok('agregar un teléfono nuevo',
  (public.add_customer_identifier(t.id('cust1'), 'phone', '+573003334455')) ->> 'outcome' = 'added');
select t.ok('agregar uno que ya tiene el mismo cliente',
  (public.add_customer_identifier(t.id('cust1'), 'phone', '+573003334455')) ->> 'outcome' = 'exists');
select t.ok('agregar uno de OTRO cliente: conflicto sin revelar a quién pertenece',
  (select r ->> 'outcome' = 'conflict' and not (r ? 'customer_id')
     from (select public.add_customer_identifier(t.id('cust1'), 'phone', '+573004445566') r) x));
select t.throws('formato inválido rechazado por la base de datos',
  format('select public.add_customer_identifier(%L, ''phone'', ''123'')', t.id('cust1')), '23514');
select t.reset();
select t.as_user(:S2);
select t.throws('sin acceso al cliente no se pueden agregar identificadores',
  format('select public.add_customer_identifier(%L, ''email'', ''x@y.com'')', t.id('cust1')), '42501');
select t.reset();

-- Regresión: un cliente SIN propietario daba NULL en can_access_row y el vendedor operaba sobre él por RPC
select t.as_service();
select t.save('sindueno', (public.ingest_lead(t.id('orgA'), '{"name":"Sin Dueño","identifiers":[{"type":"phone","value":"+573007778899"}]}'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_user(:S1);
select t.throws('un vendedor NO puede agregar identificadores a un cliente sin propietario',
  format('select public.add_customer_identifier(%L, ''phone'', ''+573007770000'')', t.id('sindueno')), '42501');
select t.ok('can_access_row devuelve false (nunca NULL) para registros sin propietario',
  app.can_access_row(t.id('orgA'), 'customers:update', null, null) is false
  and app.can_access_row(t.id('orgA'), 'customers:read', null, null) is false);
select t.reset();
select t.ok('...y no se agregó nada', (select count(*) from public.customer_identifiers where value = '+573007770000') = 0);

-- ---------------------------------------------------------------------------
-- Línea de tiempo
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.ok('el propietario ve la línea de tiempo con la creación y la fusión',
  (select count(*) filter (where type = 'customer.created') >= 1 and count(*) filter (where type = 'customer.merged') = 1
     from public.customer_timeline(t.id('cust1'))));
select t.reset();
select t.as_user(:S2);
select t.ok('quien no ve al cliente no ve su línea de tiempo', (select count(*) from public.customer_timeline(t.id('cust1'))) = 0);
select t.reset();
select t.as_anon();
select t.throws('anon no puede pedir la línea de tiempo', format('select * from public.customer_timeline(%L)', t.id('cust1')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Escrituras directas, empresa y campos personalizados
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.throws('INSERT directo en customers denegado',
  format('insert into public.customers (org_id, full_name) values (%L, ''X'')', t.id('orgA')), '42501');
select t.throws('no se puede cambiar org_id (privilegio de columna)',
  format('update public.customers set org_id = %L where id = %L', t.id('orgB'), t.id('cust1')), '42501');
select t.throws('DELETE directo denegado', format('delete from public.customers where id = %L', t.id('cust1')), '42501');
select t.reset();

select t.as_user(:M);
insert into t.res select 'co', public.create_customer(t.id('orgA'), 'company', 'Acme Corp', '[{"type":"email","value":"info@acme.co"}]'::jsonb);
select t.save('company', (select (v ->> 'customer_id')::uuid from t.res where k = 'co'));
select t.ok('una persona puede pertenecer a una empresa',
  t.affected($q$update public.customers set company_id = {company} where id = {cust1}$q$) = 1);
select t.throws('company_id debe apuntar a una empresa',
  format('update public.customers set company_id = %L where id = %L', t.id('cust3'), t.id('cust1')), '23514');
select t.reset();

select t.as_user(:A);
insert into public.custom_field_definitions (org_id, entity, key, label, type, options)
  values (t.id('orgA'), 'customer', 'nivel', 'Nivel', 'select', '["oro","plata"]');
select t.reset();
select t.as_user(:S1);
select t.ok('valor válido de campo personalizado',
  t.affected($q$update public.customers set custom_fields = '{"nivel":"oro"}' where id = {cust1}$q$) = 1);
select t.throws('opción no permitida',
  format('update public.customers set custom_fields = %L where id = %L', '{"nivel":"bronce"}', t.id('cust1')), '22023');
select t.throws('clave desconocida',
  format('update public.customers set custom_fields = %L where id = %L', '{"inventado":1}', t.id('cust1')), '22023');
select t.reset();

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select t.ok('normalize_name quita acentos, símbolos y espacios repetidos',
  app.normalize_name('  Ñandú  RODRÍGUEZ-Pérez ') = 'nandu rodriguez perez');
select t.ok('normalize_name une acentos combinados (NFD) antes de normalizar',
  app.normalize_name(E'Rodri\u0301guez Ma\u0301rquez') = 'rodriguez marquez');
select t.ok('TODAS las tablas que referencian a customers están en el registro de fusión (app.customer_merge_targets)',
  (select coalesce(array_agg(distinct conrelid::regclass::text order by conrelid::regclass::text), '{}')
     from pg_constraint where contype = 'f' and confrelid = 'public.customers'::regclass
      and conrelid::regclass::text not in ('customers', 'identity_reviews'))   -- estas dos se tratan a mano en merge_customers
  = (select coalesce(array_agg(table_name order by table_name), '{}') from app.customer_merge_targets));
select t.ok('todas las tablas de public tienen RLS',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('anon sin privilegios sobre tablas',
  (select count(*) from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public') = 0);
delete from public.organizations where id = t.id('orgB');
select t.ok('eliminar una organización elimina sus clientes y eventos sin violar FKs',
  (select count(*) from public.customers where org_id = t.id('orgB')) = 0);

rollback;
\echo ✔ IDENTIDAD: TODAS LAS PRUEBAS PASARON
