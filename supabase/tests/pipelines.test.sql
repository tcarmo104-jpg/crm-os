-- Pruebas de pipelines y etapas: pipeline inicial, permisos, invariantes y límites.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set S1 '''51000000-0000-0000-0000-000000000001'''
\set V  '''56000000-0000-0000-0000-000000000006'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values (:A, 'a@acme.test'), (:B, 'b@beta.test'), (:S1, 's1@acme.test'), (:V, 'v@acme.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('V', :V);

select t.as_user(:A); select t.save('orgA', public.create_organization('Acme', 'acme')); select t.reset();
insert into public.memberships (org_id, user_id, role_id)
  select t.id('orgA'), u.uid, r.id from (values (:S1::uuid, 'sales_agent'), (:V::uuid, 'viewer')) u(uid, rk)
  join public.roles r on r.key = u.rk and r.org_id is null;
select t.as_user(:B); select t.save('orgB', public.create_organization('Beta', 'beta')); select t.reset();

-- ---------------------------------------------------------------------------
-- Pipeline inicial
-- ---------------------------------------------------------------------------
select t.ok('cada organización nueva nace con UN pipeline por defecto',
  (select count(*) = 1 and bool_and(is_default) from public.pipelines where org_id = t.id('orgA')));
select t.save('pipe', (select id from public.pipelines where org_id = t.id('orgA')));
select t.ok('con 4 etapas abiertas, una ganada (100 %) y una perdida (0 %)',
  (select count(*) filter (where kind = 'open') = 4 and count(*) filter (where kind = 'won' and probability = 100) = 1
      and count(*) filter (where kind = 'lost' and probability = 0) = 1
     from public.pipeline_stages where pipeline_id = t.id('pipe')));
select app.seed_default_pipeline(t.id('orgA'));
select t.ok('el seed es idempotente (no duplica)', (select count(*) from public.pipelines where org_id = t.id('orgA')) = 1);

select t.as_user(:S1);
select t.ok('un vendedor ve los pipelines de su organización', (select count(*) from public.pipelines) = 1 and (select count(*) from public.pipeline_stages) = 6);
select t.reset();
select t.as_user(:B);
select t.ok('otra organización solo ve los suyos', (select count(*) from public.pipelines) = 1 and (select id from public.pipelines) <> t.id('pipe'));
select t.throws('B no puede agregar etapas al pipeline de A',
  format('insert into public.pipeline_stages (org_id, pipeline_id, name, kind, probability) values (%L, %L, ''X'', ''open'', 10)', t.id('orgB'), t.id('pipe')), '23503');
select t.reset();

-- ---------------------------------------------------------------------------
-- Crear pipelines
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.throws('un vendedor no puede crear pipelines', format('select public.create_pipeline(%L, ''Mío'')', t.id('orgA')), '42501');
select t.throws('INSERT directo en pipelines denegado (evita pipelines sin etapas)',
  format('insert into public.pipelines (org_id, name) values (%L, ''Directo'')', t.id('orgA')), '42501');
select t.reset();

select t.as_user(:A);
select t.save('pipe2', public.create_pipeline(t.id('orgA'), 'Postventa'));
select t.ok('un admin crea un pipeline y nace con sus 6 etapas',
  (select count(*) from public.pipeline_stages where pipeline_id = t.id('pipe2')) = 6
  and (select not is_default from public.pipelines where id = t.id('pipe2')));
select t.throws('el nombre es único sin importar mayúsculas', format('select public.create_pipeline(%L, ''  postVENTA '')', t.id('orgA')), '23505');
select t.throws('nombre vacío', format('select public.create_pipeline(%L, ''  '')', t.id('orgA')), '22023');
select t.reset();

-- ---------------------------------------------------------------------------
-- Etapas: alta, reglas de probabilidad, inmutabilidad
-- ---------------------------------------------------------------------------
select t.as_user(:A);
insert into public.pipeline_stages (org_id, pipeline_id, name, kind, probability) values (t.id('orgA'), t.id('pipe'), 'Demo', 'open', 60);
select t.ok('la posición de una etapa nueva se asigna al final de su tipo (de 10 en 10)',
  (select position = 50 from public.pipeline_stages where pipeline_id = t.id('pipe') and name = 'Demo'));
select t.throws('nombre de etapa repetido en el mismo pipeline',
  format('insert into public.pipeline_stages (org_id, pipeline_id, name, kind, probability) values (%L, %L, ''demo'', ''open'', 5)', t.id('orgA'), t.id('pipe')), '23505');
select t.throws('una etapa abierta no puede valer 100 %',
  format('insert into public.pipeline_stages (org_id, pipeline_id, name, kind, probability) values (%L, %L, ''Casi'', ''open'', 100)', t.id('orgA'), t.id('pipe')), '23514');
select t.throws('una etapa ganada debe valer 100 %',
  format('insert into public.pipeline_stages (org_id, pipeline_id, name, kind, probability) values (%L, %L, ''Ganada 2'', ''won'', 90)', t.id('orgA'), t.id('pipe')), '23514');
select t.throws('el tipo de etapa no se puede cambiar (privilegio de columna)',
  format('update public.pipeline_stages set kind = ''lost'' where pipeline_id = %L and name = ''Demo''', t.id('pipe')), '42501');
select t.ok('sí se puede renombrar y ajustar la probabilidad',
  t.affected($q$update public.pipeline_stages set name = 'Demostración', probability = 65 where pipeline_id = {pipe} and name = 'Demo'$q$) = 1);
select t.reset();
select t.throws('ni siquiera un superusuario puede cambiar el tipo (trigger)',
  format('update public.pipeline_stages set kind = ''lost'', probability = 0 where pipeline_id = %L and name = ''Demostración''', t.id('pipe')), '23514');

select t.as_user(:S1);
select t.ok('un vendedor no puede editar etapas (RLS: 0 filas afectadas)',
  t.affected($q$update public.pipeline_stages set name = 'Hack' where pipeline_id = {pipe}$q$) = 0);
select t.reset();
select t.ok('...y ninguna etapa cambió', (select count(*) from public.pipeline_stages where name = 'Hack') = 0);

-- ---------------------------------------------------------------------------
-- Archivar
-- ---------------------------------------------------------------------------
select t.as_user(:A);
select t.throws('no se puede archivar la última etapa "perdida" activa',
  format('update public.pipeline_stages set archived_at = now() where pipeline_id = %L and kind = ''lost''', t.id('pipe')), '23514');
select t.ok('sí se puede archivar una etapa vacía',
  t.affected($q$update public.pipeline_stages set archived_at = now() where pipeline_id = {pipe} and name = 'Demostración'$q$) = 1);
select t.throws('el pipeline por defecto no se puede archivar',
  format('update public.pipelines set archived_at = now() where id = %L', t.id('pipe')), '23514');
select t.ok('un pipeline que no es el predeterminado sí', t.affected($q$update public.pipelines set archived_at = now() where id = {pipe2}$q$) = 1);
select t.reset();

-- ---------------------------------------------------------------------------
-- Pipeline por defecto
-- ---------------------------------------------------------------------------
select t.as_user(:A);
select t.save('pipe3', public.create_pipeline(t.id('orgA'), 'Renovaciones'));
select t.throws('is_default no se escribe directamente (privilegio de columna)',
  format('update public.pipelines set is_default = true where id = %L', t.id('pipe3')), '42501');
select public.set_default_pipeline(t.id('pipe3'));
select t.reset();
select t.ok('set_default_pipeline cambia el predeterminado y solo queda uno',
  (select count(*) = 1 and bool_and(id = t.id('pipe3')) from public.pipelines where org_id = t.id('orgA') and is_default and archived_at is null));
select t.as_user(:S1);
select t.throws('un vendedor no puede cambiar el predeterminado', format('select public.set_default_pipeline(%L)', t.id('pipe')), '42501');
select t.reset();
select t.as_user(:B);
select t.throws('B no puede tocar pipelines de A', format('select public.set_default_pipeline(%L)', t.id('pipe')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Límites
-- ---------------------------------------------------------------------------
select t.as_user(:A);
insert into public.pipeline_stages (org_id, pipeline_id, name, kind, probability)
  select t.id('orgA'), t.id('pipe3'), 'Extra ' || g, 'open', 5 from generate_series(1, 19) g;
select t.ok('hasta 25 etapas activas por pipeline (6 + 19)',
  (select count(*) from public.pipeline_stages where pipeline_id = t.id('pipe3') and archived_at is null) = 25);
select t.throws('la etapa 26 se rechaza',
  format('insert into public.pipeline_stages (org_id, pipeline_id, name, kind, probability) values (%L, %L, ''Una más'', ''open'', 5)', t.id('orgA'), t.id('pipe3')), '53400');
select t.reset();
select t.as_user(:A);
select t.ok('hasta 10 pipelines activos',
  (select count(public.create_pipeline(t.id('orgA'), 'P' || g)) from generate_series(1, 7) g) = 7);   -- 1 (predet.) + 1 (Renovaciones) + 7 = 9 activos; Postventa está archivado
select public.create_pipeline(t.id('orgA'), 'P8');
select t.throws('el pipeline 11 se rechaza', format('select public.create_pipeline(%L, ''P9'')', t.id('orgA')), '53400');
select t.reset();

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------
select t.ok('todas las tablas de public tienen RLS',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('anon sin privilegios sobre tablas',
  (select count(*) from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public') = 0);
select t.ok('las funciones internas de pipelines no son ejecutables por authenticated',
  not has_function_privilege('authenticated', 'app.seed_default_pipeline(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.add_default_stages(uuid, uuid)', 'EXECUTE'));

rollback;
\echo ✔ PIPELINES: TODAS LAS PRUEBAS PASARON
