-- Pruebas de 0024: crear un lead a mano (misma resolución de identidad que la importación CSV).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-c303-0000-0000-00000000000a'''
\set S1 '''51000000-c303-0000-0000-000000000001'''
\set V1 '''6a000000-c303-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@lm.test'), (:S1, 's1@lm.test'), (:V1, 'v1@lm.test');
select t.as_user(:A); select t.save('org', public.create_organization('Leads Manual', 'leads-manual'));
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :S1::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :V1::uuid, r.id from public.roles r where r.key = 'viewer' and r.org_id is null;
select t.reset();

create table t.res_json (k text primary key, v jsonb); grant all on table t.res_json to public;
select t.as_user(:A);
insert into t.res_json values ('r1', public.create_lead(t.id('org'), '{"name":"Camila Ruiz","identifiers":[{"type":"phone","value":"+573201110088"}],"source":"feria","product_interest":"Wallpanel"}'::jsonb));
select t.ok('crea el cliente nuevo y el lead, y devuelve ambos ids (a diferencia de import_leads)',
  (select (v ->> 'outcome') = 'created' and (v ->> 'deduplicated')::boolean = false and (v ->> 'lead_id') is not null and (v ->> 'customer_id') is not null from t.res_json where k = 'r1'));
select t.ok('el lead queda con la fuente y el interés',
  (select source = 'feria' and product_interest = 'Wallpanel' from public.leads where id = (select (v ->> 'lead_id')::uuid from t.res_json where k = 'r1')));
select t.reset();

select t.as_user(:S1);
insert into t.res_json select 'r2', public.create_lead(t.id('org'), '{"name":"Otro Lead","identifiers":[{"type":"phone","value":"+573201110099"}],"source":"web"}'::jsonb);
select t.ok('un vendedor SÍ puede crear un lead, y queda como su propietario',
  (select owner_id = :S1::uuid from public.customers where id = (select (v ->> 'customer_id')::uuid from t.res_json where k = 'r2')));
select t.reset();

select t.as_user(:A);
insert into t.res_json select 'r3', public.create_lead(t.id('org'), '{"name":"Camila Ruiz","identifiers":[{"type":"phone","value":"+573201110088"}],"source":"referido"}'::jsonb);
select t.ok('el MISMO teléfono se reconoce como el mismo cliente (misma lógica que la importación): no se duplica',
  (select (select v ->> 'customer_id' from t.res_json where k = 'r3') = (select v ->> 'customer_id' from t.res_json where k = 'r1'))
  and (select (v ->> 'outcome') = 'matched' from t.res_json where k = 'r3'));
select t.ok('...pero SÍ queda un nuevo lead (una nueva señal de entrada)',
  (select (select v ->> 'lead_id' from t.res_json where k = 'r3') <> (select v ->> 'lead_id' from t.res_json where k = 'r1')));
select t.reset();

select t.as_user(:V1); select t.throws('un viewer no puede crear leads', format('select public.create_lead(%L, ''{"name":"X","source":"web"}''::jsonb)', t.id('org')), '42501'); select t.reset();
select t.as_user(:A);
select t.throws('sin nombre se rechaza', format('select public.create_lead(%L, ''{"source":"web"}''::jsonb)', t.id('org')), '22023');
select t.throws('sin fuente se rechaza', format('select public.create_lead(%L, ''{"name":"Sin fuente"}''::jsonb)', t.id('org')), '22023');
select t.reset();
select t.as_anon(); select t.throws('un an00f3nimo no puede ejecutar la funci00f3n en absoluto', format('select public.create_lead(%L, ''{"name":"X","source":"web"}''::jsonb)', t.id('org')), '42501'); select t.reset();

rollback;
\echo ✔ CREAR LEAD A MANO: TODAS LAS PRUEBAS PASARON
