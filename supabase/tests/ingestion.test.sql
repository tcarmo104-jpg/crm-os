-- Pruebas de captura de leads (API / CSV), idempotencia, llaves de API y límite de peticiones.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set S1 '''51000000-0000-0000-0000-000000000001'''
\set M  '''4d000000-0000-0000-0000-00000000000d'''
\set V  '''56000000-0000-0000-0000-000000000006'''

begin;
\i supabase/tests/support/test_helpers.sql
create table t.res (k text primary key, v jsonb);
grant all on t.res to public;

insert into auth.users (id, email) values
  (:A, 'a@acme.test'), (:B, 'b@beta.test'), (:S1, 's1@acme.test'), (:M, 'm@acme.test'), (:V, 'v@acme.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('M', :M), ('V', :V);

select t.as_user(:A);
select t.save('orgA', public.create_organization('Acme', 'acme'));
insert into public.memberships (org_id, user_id, role_id)
  select t.id('orgA'), u.uid, r.id
    from (values (:S1::uuid, 'sales_agent'), (:M::uuid, 'manager'), (:V::uuid, 'viewer')) u(uid, rk)
    join public.roles r on r.key = u.rk and r.org_id is null;
insert into public.custom_field_definitions (org_id, entity, key, label, type)
  values (t.id('orgA'), 'lead', 'presupuesto', 'Presupuesto', 'number');
select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Beta', 'beta')); select t.reset();

-- ---------------------------------------------------------------------------
-- Ingesta (endpoint público → service_role)
-- ---------------------------------------------------------------------------
select t.as_service();
insert into t.res select 'l1', public.ingest_lead(t.id('orgA'), $j${
  "name":"Laura Gómez","identifiers":[{"type":"phone","value":"+573101112233"},{"type":"email","value":"laura@x.com"}],
  "source":"instagram","channel":"social","campaign":"verano","external_id":"ig-1",
  "phone":"310 111 2233","email":"Laura@X.com","product_interest":"Producto A","consent":true,"raw":{"a":1}}$j$::jsonb);
select t.reset();
select t.save('laura', (select (v ->> 'customer_id')::uuid from t.res where k = 'l1'));

select t.ok('cliente y lead nuevos', (select v ->> 'outcome' = 'created' and v ->> 'deduplicated' = 'false' from t.res where k = 'l1'));
select t.ok('sin asignar: propietario nulo en cliente y lead',
  (select c.owner_id is null and l.owner_id is null and l.status = 'new' and l.source = 'instagram' and l.campaign = 'verano'
     and l.contact_phone = '310 111 2233' and l.consent
     from public.customers c join public.leads l on l.customer_id = c.id where c.id = t.id('laura')));
select t.ok('se emiten customer.created y lead.created ligados al cliente',
  (select count(distinct type) from public.domain_events
    where customer_id = t.id('laura') and type in ('customer.created', 'lead.created')) = 2);

select t.as_user(:S1);
select t.ok('un vendedor NO ve leads/clientes sin asignar',
  (select count(*) from public.customers) = 0 and (select count(*) from public.leads) = 0);
select t.reset();
select t.as_user(:M);
select t.ok('el manager sí los ve', (select count(*) from public.customers) = 1 and (select count(*) from public.leads) = 1);
select t.reset();

-- Idempotencia
select t.as_service();
insert into t.res select 'l1b', public.ingest_lead(t.id('orgA'), $j${
  "name":"Laura Gómez","identifiers":[{"type":"phone","value":"+573101112233"}],"source":"instagram","external_id":"ig-1"}$j$::jsonb);
select t.reset();
select t.ok('reintentar el mismo external_id no duplica el lead',
  (select v ->> 'deduplicated' = 'true' and v ->> 'lead_id' = (select v ->> 'lead_id' from t.res where k = 'l1') from t.res where k = 'l1b')
  and (select count(*) from public.leads) = 1);

-- Asignar y enrutar al propietario
select t.as_user(:M);
select t.ok('el manager asigna el cliente a S1',
  t.affected($q$update public.customers set owner_id = {S1} where id = {laura}$q$) = 1);
select t.reset();
select t.as_user(:S1);
select t.ok('el lead abierto siguió al cliente: S1 lo ve', (select count(*) from public.leads) = 1);
select t.reset();

select t.as_service();
insert into t.res select 'l2', public.ingest_lead(t.id('orgA'), $j${
  "name":"Laura G.","identifiers":[{"type":"phone","value":"+573101112233"},{"type":"email","value":"laura.g@otro.com"}],
  "source":"web","campaign":"black-friday","product_interest":"Producto B"}$j$::jsonb);
select t.reset();
select t.ok('cliente existente: el lead se enruta al propietario, sin duplicar',
  (select v ->> 'outcome' = 'matched' and (v ->> 'customer_id')::uuid = t.id('laura') from t.res where k = 'l2')
  and (select count(*) from public.customers where org_id = t.id('orgA')) = 1
  and (select owner_id = :S1 from public.leads where id = (select (v ->> 'lead_id')::uuid from t.res where k = 'l2')));
select t.ok('se enriquece el cliente con el identificador nuevo',
  (select count(*) from public.customer_identifiers where customer_id = t.id('laura')) = 3);
select t.as_user(:S1);
select t.ok('S1 ve sus 2 leads y su cliente', (select count(*) from public.leads) = 2 and (select count(*) from public.customers) = 1);
select t.reset();

-- Conflicto y nombre repetido
select t.as_service();
select public.ingest_lead(t.id('orgA'), '{"name":"Ana Ruiz","identifiers":[{"type":"phone","value":"+573201110000"}]}'::jsonb);
select public.ingest_lead(t.id('orgA'), '{"name":"Beto Paz","identifiers":[{"type":"phone","value":"+573202220000"}]}'::jsonb);
insert into t.res select 'lc', public.ingest_lead(t.id('orgA'), '{"name":"Ana","identifiers":[{"type":"phone","value":"+573201110000"},{"type":"phone","value":"+573202220000"}]}'::jsonb);
insert into t.res select 'lr', public.ingest_lead(t.id('orgA'), '{"name":"laura gomez","identifiers":[{"type":"phone","value":"+573109998877"}]}'::jsonb);
select t.reset();
select t.ok('identificadores de dos clientes → conflicto, sin fusión automática',
  (select v ->> 'outcome' = 'conflict' from t.res where k = 'lc')
  and (select count(*) from public.identity_reviews where kind = 'identifier_conflict') = 1
  and (select count(*) from public.customers where full_name in ('Ana Ruiz', 'Beto Paz')) = 2);
select t.ok('mismo nombre sin identificador común → se crea y queda en revisión',
  (select v ->> 'outcome' = 'review' from t.res where k = 'lr')
  and (select count(*) from public.identity_reviews where kind = 'possible_duplicate' and status = 'pending') = 1);

-- Sin nombre
select t.as_service();
insert into t.res select 'n1', public.ingest_lead(t.id('orgA'), '{"identifiers":[{"type":"email","value":"anon1@x.com"}]}'::jsonb);
insert into t.res select 'n2', public.ingest_lead(t.id('orgA'), '{"identifiers":[{"type":"email","value":"anon2@x.com"}]}'::jsonb);
select t.reset();
select t.ok('leads sin nombre se guardan como "Sin nombre" y NO se marcan como duplicados entre sí',
  (select v ->> 'outcome' = 'created' from t.res where k = 'n1') and (select v ->> 'outcome' = 'created' from t.res where k = 'n2')
  and (select count(*) from public.customers where full_name = 'Sin nombre') = 2);

-- Validaciones
select t.as_service();
select t.throws('sin identificadores → contact_required', format('select public.ingest_lead(%L, %L)', t.id('orgA'), '{"name":"X","identifiers":[]}'), '22023');
select t.throws('sin la clave identifiers', format('select public.ingest_lead(%L, %L)', t.id('orgA'), '{"name":"X"}'), '22023');
select t.throws('teléfono sin formato E.164 rechazado por la BD',
  format('select public.ingest_lead(%L, %L)', t.id('orgA'), '{"name":"X","identifiers":[{"type":"phone","value":"3101112233"}]}'), '23514');
select t.throws('email sin normalizar rechazado por la BD',
  format('select public.ingest_lead(%L, %L)', t.id('orgA'), '{"name":"X","identifiers":[{"type":"email","value":"MAYUS@X.COM"}]}'), '23514');
select t.throws('demasiados identificadores',
  format('select public.ingest_lead(%L, %L)', t.id('orgA'), (select jsonb_build_object('name', 'X', 'identifiers',
     jsonb_agg(jsonb_build_object('type', 'external', 'value', 'id' || g))) from generate_series(1, 11) g)::text), '22023');
select t.throws('campo personalizado de lead con tipo incorrecto',
  format('select public.ingest_lead(%L, %L)', t.id('orgA'), '{"name":"X","identifiers":[{"type":"email","value":"cf@x.com"}],"custom_fields":{"presupuesto":"alto"}}'), '22023');
select t.ok('campo personalizado válido',
  (select public.ingest_lead(t.id('orgA'), '{"name":"Con Campo","identifiers":[{"type":"email","value":"cf2@x.com"}],"custom_fields":{"presupuesto":5000}}') ->> 'outcome') = 'created');
select t.reset();

-- No contactar
select t.as_user(:M);
select t.ok('manager marca "no contactar"', t.affected($q$update public.customers set do_not_contact = true where id = {laura}$q$) = 1);
select t.reset();
select t.as_service();
insert into t.res select 'ldnc', public.ingest_lead(t.id('orgA'), '{"name":"Laura","identifiers":[{"type":"phone","value":"+573101112233"}],"source":"web"}'::jsonb);
select t.reset();
select t.ok('un lead de un cliente "no contactar" se registra y el evento lo advierte (las automatizaciones lo respetarán)',
  (select (payload ->> 'do_not_contact')::boolean from public.domain_events
    where type = 'lead.created' and entity_id = (select (v ->> 'lead_id')::uuid from t.res where k = 'ldnc')));

-- Permisos de la RPC pública
select t.as_user(:S1);
select t.throws('un usuario autenticado NO puede llamar ingest_lead',
  format('select public.ingest_lead(%L, %L)', t.id('orgA'), '{"identifiers":[{"type":"email","value":"h@x.com"}]}'), '42501');
select t.reset();
select t.as_anon();
select t.throws('anon NO puede llamar ingest_lead',
  format('select public.ingest_lead(%L, %L)', t.id('orgA'), '{"identifiers":[{"type":"email","value":"h@x.com"}]}'), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Importación (CSV)
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
insert into t.res select 'imp', public.import_leads(t.id('orgA'), $j$[
  {"name":"Importado Uno","identifiers":[{"type":"phone","value":"+573301110001"}],"source":"csv"},
  {"name":"Sin contacto","identifiers":[]},
  {"name":"Campo malo","identifiers":[{"type":"phone","value":"+573301110003"}],"custom_fields":{"presupuesto":"x"}},
  {"name":"Importado Uno","identifiers":[{"type":"phone","value":"+573301110001"}],"source":"csv"}
]$j$::jsonb);
select t.ok('importa 4 filas y devuelve un resultado por fila', (select jsonb_array_length(v) = 4 from t.res where k = 'imp'));
select t.ok('fila válida → created', (select v -> 0 ->> 'outcome' = 'created' from t.res where k = 'imp'));
select t.ok('fila sin contacto → error 22023 con mensaje de validación',
  (select v -> 1 ->> 'error_code' = '22023' and v -> 1 ->> 'error' = 'contact_required' from t.res where k = 'imp'));
select t.ok('fila con campo inválido → error 22023',
  (select v -> 2 ->> 'error_code' = '22023' from t.res where k = 'imp'));
select t.ok('la misma persona repetida en el archivo → matched (sin duplicar)',
  (select v -> 3 ->> 'outcome' = 'matched' from t.res where k = 'imp'));
select t.ok('un error en una fila NO revierte las demás',
  (select count(*) from public.customers where full_name = 'Importado Uno') = 1);
select t.ok('quien no ve toda la cartera queda como propietario de lo importado',
  (select count(*) from public.leads where source = 'csv') = 2);
select t.throws('más de 500 filas por llamada',
  format('select public.import_leads(%L, %L)', t.id('orgA'), (select jsonb_agg('{}'::jsonb) from generate_series(1, 501))::text), '22023');
select t.reset();

select t.as_user(:V);
select t.throws('un viewer no puede importar (sin leads:create)',
  format('select public.import_leads(%L, ''[]'')', t.id('orgA')), '42501');
select t.reset();
select t.as_user(:B);
select t.throws('B no puede importar a la organización de A',
  format('select public.import_leads(%L, ''[]'')', t.id('orgA')), '42501');
select t.reset();

select t.as_user(:M);
insert into t.res select 'impm', public.import_leads(t.id('orgA'), '[{"name":"Lote Manager","identifiers":[{"type":"phone","value":"+573301110009"}]}]'::jsonb, false);
select t.reset();
select t.ok('el manager puede importar sin asignar (queda en la bandeja de sin asignar)',
  (select owner_id is null from public.customers where full_name = 'Lote Manager'));

-- ---------------------------------------------------------------------------
-- Llaves de API
-- ---------------------------------------------------------------------------
select t.as_user(:A);
insert into t.res select 'key', to_jsonb(public.create_api_key(t.id('orgA'), 'Web principal'));
select t.reset();
select t.ok('la llave tiene formato crm_ + 64 hex', (select (v #>> '{}') ~ '^crm_[0-9a-f]{64}$' from t.res where k = 'key'));
select t.ok('en BD solo se guarda su SHA-256 y un prefijo',
  (select key_hash = encode(sha256(convert_to((select v #>> '{}' from t.res where k = 'key'), 'UTF8')), 'hex')
      and key_prefix = left((select v #>> '{}' from t.res where k = 'key'), 12)
      and key_hash <> (select v #>> '{}' from t.res where k = 'key')
     from public.api_keys where org_id = t.id('orgA')));

select t.as_user(:S1);
select t.throws('un vendedor no puede crear llaves', format('select public.create_api_key(%L, ''x'')', t.id('orgA')), '42501');
select t.ok('un vendedor no ve las llaves', (select count(*) from public.api_keys) = 0);
select t.reset();
select t.as_user(:B);
select t.throws('B no puede crear llaves para A', format('select public.create_api_key(%L, ''x'')', t.id('orgA')), '42501');
select t.reset();
select t.as_user(:A);
select t.ok('el admin ve sus llaves', (select count(*) from public.api_keys) = 1);
select t.throws('key_hash no es legible', $$select key_hash from public.api_keys$$, '42501');
select t.reset();

select t.as_service();
select t.ok('api_authenticate acepta la llave y devuelve la organización',
  (select r ->> 'ok' = 'true' and (r ->> 'org_id')::uuid = t.id('orgA')
     from (select public.api_authenticate(encode(sha256(convert_to((select v #>> '{}' from t.res where k = 'key'), 'UTF8')), 'hex')) r) x));
select t.ok('una llave desconocida es inválida',
  (public.api_authenticate(repeat('0', 64))) ->> 'reason' = 'invalid');
select t.reset();
select t.ok('last_used_at se actualiza', (select last_used_at is not null from public.api_keys where org_id = t.id('orgA')));

select t.as_user(:S1);
select t.throws('un usuario no puede llamar api_authenticate', $$select public.api_authenticate('x')$$, '42501');
select t.reset();

-- Límite de peticiones
select t.as_user(:A);
insert into t.res select 'key2', to_jsonb(public.create_api_key(t.id('orgA'), 'Limitada'));
select t.reset();
update public.api_keys set rate_limit_per_min = 3 where name = 'Limitada';
select t.as_service();
select t.ok('3 llamadas dentro del límite',
  (select bool_and(public.api_authenticate(h) ->> 'ok' = 'true')
     from (select encode(sha256(convert_to((select v #>> '{}' from t.res where k = 'key2'), 'UTF8')), 'hex') h from generate_series(1, 3)) s));
select t.ok('la 4.ª se rechaza con retry_after',
  (select r ->> 'reason' = 'rate_limited' and (r ->> 'retry_after')::int between 1 and 60
     from (select public.api_authenticate(encode(sha256(convert_to((select v #>> '{}' from t.res where k = 'key2'), 'UTF8')), 'hex')) r) x));
select t.reset();

-- Revocar
select t.as_user(:S1);
select t.throws('un vendedor no puede revocar llaves',
  format('select public.revoke_api_key(%L)', (select id from public.api_keys where name = 'Web principal')), '42501');
select t.reset();
select t.as_user(:A);
select public.revoke_api_key((select id from public.api_keys where name = 'Web principal'));
select t.reset();
select t.as_service();
select t.ok('una llave revocada deja de funcionar',
  (public.api_authenticate(encode(sha256(convert_to((select v #>> '{}' from t.res where k = 'key'), 'UTF8')), 'hex'))) ->> 'reason' = 'invalid');
select t.reset();

-- ---------------------------------------------------------------------------
-- Auditoría y estructura
-- ---------------------------------------------------------------------------
select t.ok('la auditoría registra leads y llaves',
  (select count(*) from public.audit_logs where entity_type in ('leads', 'api_keys')) > 0);
select t.ok('la auditoría NUNCA contiene key_hash, token_hash ni raw_payload',
  (select count(*) from public.audit_logs
    where new_values ?| array['key_hash', 'token_hash', 'raw_payload'] or old_values ?| array['key_hash', 'token_hash', 'raw_payload']) = 0);
select t.ok('todas las tablas de public tienen RLS',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('authenticated no puede escribir en leads, api_keys ni api_rate_limits directamente',
  not has_table_privilege('authenticated', 'public.leads', 'INSERT')
  and not has_table_privilege('authenticated', 'public.api_keys', 'INSERT')
  and not has_table_privilege('authenticated', 'public.api_rate_limits', 'SELECT'));

rollback;
\echo ✔ INGESTA: TODAS LAS PRUEBAS PASARON
