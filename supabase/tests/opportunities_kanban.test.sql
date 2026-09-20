-- Pruebas de 0015: número, prioridad, temperatura, canal, conversación y etapas por defecto.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-6666-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-6666-0000-0000-00000000000b'''
\set S1 '''51000000-6666-0000-0000-000000000001'''
\set S2 '''52000000-6666-0000-0000-000000000002'''
\set V  '''56000000-6666-0000-0000-000000000006'''
\set T1 '''11111111-6666-0000-0000-000000000001'''
\set T2 '''22222222-6666-0000-0000-000000000002'''
\set PID '''509876543210'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values (:A, 'a@k.test'), (:B, 'b@k.test'), (:S1, 's1@k.test'), (:S2, 's2@k.test'), (:V, 'v@k.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('S2', :S2), ('V', :V);

select t.as_user(:A); select t.save('orgA', public.create_organization('Kanban A', 'kanban-a'));
insert into public.teams (id, org_id, name) values (:T1, t.id('orgA'), 'Norte'), (:T2, t.id('orgA'), 'Sur');
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), u.uid, r.id, u.team
    from (values (:S1::uuid, 'sales_agent', :T1::uuid), (:S2::uuid, 'sales_agent', :T2::uuid), (:V::uuid, 'viewer', null::uuid)) u(uid, rk, team)
    join public.roles r on r.key = u.rk and r.org_id is null;
select public.create_channel(t.id('orgA'), 'Ventas', :PID, null, 'EAAB-token-abcdefghijklmnopqrstuvwxyz');
select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Kanban B', 'kanban-b')); select t.reset();

-- Etapas por defecto de una organización NUEVA
select t.save('pipe', (select id from public.pipelines where org_id = t.id('orgA') and is_default));
select t.ok('el pipeline nuevo nace con Nueva · Contactado · Calificada · Cotización · Negociación · Ganada · Perdida',
  (select string_agg(name, ' > ' order by position) from public.pipeline_stages where pipeline_id = t.id('pipe') and kind = 'open') = 'Nueva > Contactado > Calificada > Cotización > Negociación'
  and (select count(*) = 1 from public.pipeline_stages where pipeline_id = t.id('pipe') and kind = 'won' and name = 'Ganada')
  and (select count(*) = 1 from public.pipeline_stages where pipeline_id = t.id('pipe') and kind = 'lost' and name = 'Perdida'));

-- Clientes, conversación y oportunidades
select t.as_user(:S1);
select t.save('carlos', (public.create_customer(t.id('orgA'), 'person', 'Carlos Kanban', '[{"type":"phone","value":"+573001110066"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_user(:S2);
select t.save('dana', (public.create_customer(t.id('orgA'), 'person', 'Dana Kanban', '[{"type":"phone","value":"+573001110067"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_service(); select public.ingest_whatsapp_message(:PID, '573001110066', 'Carlos Kanban', 'k.1', 'text', 'Quiero cotizar sillas', now()); select t.reset();
select t.save('conv_c', (select id from public.conversations where thread_key = '573001110066'));

select t.as_user(:S1); select t.save('opp1', public.create_opportunity(t.id('carlos'), 'Compra de sillas', 1000000, null, null, 'Silla ergonómica')); select t.reset();
select t.as_user(:S2); select t.save('opp2', public.create_opportunity(t.id('dana'), 'Compra de mesas', 500000, null, null, null)); select t.reset();
select t.as_user(:B);
select t.save('cb', (public.create_customer(t.id('orgB'), 'person', 'Cliente B', '[{"type":"phone","value":"+573001110068"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('oppb', public.create_opportunity(t.id('cb'), 'Oportunidad B', 1, null, null, null));
select t.reset();

select t.ok('al crearla toma la conversación Y el canal del cliente',
  (select channel = 'whatsapp' and conversation_id = t.id('conv_c') from public.opportunities where id = t.id('opp1')));

-- Número correlativo
select t.ok('cada organización numera desde OPP-0001, en orden de creación',
  (select number = 'OPP-0001' from public.opportunities where id = t.id('opp1'))
  and (select number = 'OPP-0002' from public.opportunities where id = t.id('opp2'))
  and (select number = 'OPP-0001' from public.opportunities where id = t.id('oppb')));
select t.throws('el número no se cambia (ni aunque se intente como superusuario)', format('update public.opportunities set number = ''OPP-9999'' where id = %L', t.id('opp1')), '23514');
select t.as_user(:S1);
select t.throws('un vendedor no puede escribir el número (sin permiso de columna)', format('update public.opportunities set number = ''OPP-9999'' where id = %L', t.id('opp1')), '42501');
select t.reset();
select t.throws('el número es único por organización', format('insert into public.opportunities (org_id, customer_id, pipeline_id, stage_id, title, number) select org_id, customer_id, pipeline_id, stage_id, ''x'', ''OPP-0001'' from public.opportunities where id = %L', t.id('opp1')), '23505');

-- Prioridad, temperatura, canal
select t.ok('la prioridad nace «media» y la temperatura vacía (es opcional)',
  (select priority = 'medium' and temperature is null from public.opportunities where id = t.id('opp1')));
select t.as_user(:S1);
select t.ok('el dueño cambia prioridad, temperatura y canal', t.affected($q$update public.opportunities set priority = 'high', temperature = 'hot', channel = 'email' where id = {opp1}$q$) = 1);
select t.throws('prioridad inválida', format('update public.opportunities set priority = ''urgente'' where id = %L', t.id('opp1')), '23514');
select t.throws('temperatura inválida', format('update public.opportunities set temperature = ''helada'' where id = %L', t.id('opp1')), '23514');
select t.throws('canal inválido', format('update public.opportunities set channel = ''telegram'' where id = %L', t.id('opp1')), '23514');
select t.reset();
select t.as_user(:S2);
select t.ok('otro vendedor NO puede cambiarlas en una oportunidad ajena', t.affected($q$update public.opportunities set priority = 'low' where id = {opp1}$q$) = 0);
select t.reset();
select t.as_user(:V);
select t.ok('un viewer tampoco', t.affected($q$update public.opportunities set priority = 'low' where id = {opp1}$q$) = 0);
select t.reset();
select t.ok('prioridad y temperatura son independientes de la etapa', (select priority = 'high' and temperature = 'hot' and status = 'open' from public.opportunities where id = t.id('opp1')));

-- Conversación
select t.ok('al crearla se enlaza sola a la conversación del cliente y toma su canal (si no se indicó otro)',
  (select conversation_id = t.id('conv_c') from public.opportunities where id = t.id('opp1')));
select t.ok('sin conversación previa, queda sin vínculo', (select conversation_id is null and channel is null from public.opportunities where id = t.id('opp2')));
select t.as_user(:S2);
select t.throws('no se puede enlazar una conversación de OTRO cliente', format('select public.link_opportunity_conversation(%L, %L)', t.id('opp2'), t.id('conv_c')), '23514');
select t.reset();
select t.as_user(:S1);
select public.link_opportunity_conversation(t.id('opp1'), null);
select t.reset();
select t.ok('se puede desvincular', (select conversation_id is null from public.opportunities where id = t.id('opp1')));
select t.as_user(:S1); select public.link_opportunity_conversation(t.id('opp1'), t.id('conv_c')); select t.reset();
select t.ok('y volver a vincular la del mismo cliente', (select conversation_id = t.id('conv_c') from public.opportunities where id = t.id('opp1')));
select t.as_user(:S2); select t.throws('otro vendedor no vincula en oportunidades ajenas', format('select public.link_opportunity_conversation(%L, %L)', t.id('opp1'), null), '42501'); select t.reset();
select t.as_user(:V);  select t.throws('un viewer tampoco', format('select public.link_opportunity_conversation(%L, %L)', t.id('opp1'), null), '42501'); select t.reset();
select t.as_user(:S1); select t.throws('y no se escribe conversation_id directamente', format('update public.opportunities set conversation_id = null where id = %L', t.id('opp1')), '42501'); select t.reset();

-- Actualización CONSERVADORA de pipelines existentes
insert into public.pipelines (org_id, name, is_default) values (t.id('orgA'), 'Antiguo', false);
select t.save('legacy', (select id from public.pipelines where org_id = t.id('orgA') and name = 'Antiguo'));
insert into public.pipeline_stages (org_id, pipeline_id, name, kind, position, probability) values
  (t.id('orgA'), t.id('legacy'), 'Nuevo', 'open', 10, 10), (t.id('orgA'), t.id('legacy'), 'Contactado', 'open', 20, 25),
  (t.id('orgA'), t.id('legacy'), 'Propuesta', 'open', 30, 50), (t.id('orgA'), t.id('legacy'), 'Negociación', 'open', 40, 75),
  (t.id('orgA'), t.id('legacy'), 'Ganada', 'won', 10, 100), (t.id('orgA'), t.id('legacy'), 'Perdida', 'lost', 10, 0);
insert into public.pipelines (org_id, name, is_default) values (t.id('orgA'), 'Personalizado', false);
select t.save('custom', (select id from public.pipelines where org_id = t.id('orgA') and name = 'Personalizado'));
insert into public.pipeline_stages (org_id, pipeline_id, name, kind, position, probability) values
  (t.id('orgA'), t.id('custom'), 'Nuevo', 'open', 10, 10), (t.id('orgA'), t.id('custom'), 'Contactado', 'open', 20, 25),
  (t.id('orgA'), t.id('custom'), 'Propuesta', 'open', 30, 50), (t.id('orgA'), t.id('custom'), 'Negociación', 'open', 40, 75),
  (t.id('orgA'), t.id('custom'), 'Mi etapa propia', 'open', 50, 90),
  (t.id('orgA'), t.id('custom'), 'Ganada', 'won', 10, 100), (t.id('orgA'), t.id('custom'), 'Perdida', 'lost', 10, 0);
select t.ok('un pipeline con las etapas ORIGINALES se actualiza (y solo ese)', app.upgrade_legacy_default_stages() = 1);
select t.ok('...quedando Nueva · Contactado · Calificada · Cotización · Negociación en ese orden',
  (select string_agg(name, ' > ' order by position) from public.pipeline_stages where pipeline_id = t.id('legacy') and kind = 'open') = 'Nueva > Contactado > Calificada > Cotización > Negociación'
  and (select probability = 40 from public.pipeline_stages where pipeline_id = t.id('legacy') and name = 'Calificada'));
select t.ok('un pipeline PERSONALIZADO no se toca',
  (select string_agg(name, ' > ' order by position) from public.pipeline_stages where pipeline_id = t.id('custom') and kind = 'open') = 'Nuevo > Contactado > Propuesta > Negociación > Mi etapa propia');
select t.ok('es idempotente: una segunda pasada no cambia nada', app.upgrade_legacy_default_stages() = 0);

-- Estructura
select t.ok('todas las tablas de public tienen RLS', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('las funciones nuevas no son ejecutables por anónimos ni las internas por usuarios',
  not has_function_privilege('anon', 'public.link_opportunity_conversation(uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.opportunities_defaults()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.upgrade_legacy_default_stages()', 'EXECUTE'));

rollback;
\echo ✔ OPORTUNIDADES KANBAN: TODAS LAS PRUEBAS PASARON
