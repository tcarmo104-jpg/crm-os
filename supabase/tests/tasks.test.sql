-- Pruebas de tareas y actividades: visibilidad, asignación, ciclo de vida, seguimiento del cliente y fusión.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set S1 '''51000000-0000-0000-0000-000000000001'''
\set S2 '''52000000-0000-0000-0000-000000000002'''
\set M  '''4d000000-0000-0000-0000-00000000000d'''
\set E  '''e0000000-0000-0000-0000-00000000000e'''
\set V  '''56000000-0000-0000-0000-000000000006'''
\set T1 '''11111111-0000-0000-0000-000000000001'''
\set T2 '''22222222-0000-0000-0000-000000000002'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values
  (:A, 'a@acme.test'), (:B, 'b@beta.test'), (:S1, 's1@acme.test'), (:S2, 's2@acme.test'),
  (:M, 'm@acme.test'), (:E, 'e@acme.test'), (:V, 'v@acme.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('S2', :S2), ('M', :M), ('E', :E), ('V', :V), ('T1', :T1), ('T2', :T2);

select t.as_user(:A); select t.save('orgA', public.create_organization('Acme', 'acme'));
insert into public.teams (id, org_id, name) values (:T1, t.id('orgA'), 'Bogotá'), (:T2, t.id('orgA'), 'Medellín');
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), u.uid, r.id, u.team
    from (values (:S1::uuid, 'sales_agent', :T1::uuid), (:S2::uuid, 'sales_agent', :T2::uuid), (:M::uuid, 'manager', null::uuid),
                 (:E::uuid, 'sales_manager', :T1::uuid), (:V::uuid, 'viewer', null::uuid)) u(uid, rk, team)
    join public.roles r on r.key = u.rk and r.org_id is null;
select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Beta', 'beta')); select t.reset();

select t.as_user(:S1);
select t.save('carlos', (public.create_customer(t.id('orgA'), 'person', 'Carlos Rodríguez', '[{"type":"phone","value":"+573001112233"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('opp1', public.create_opportunity(t.id('carlos'), 'Plan A', 1000));
select t.reset();
select t.as_user(:S2);
select t.save('diana', (public.create_customer(t.id('orgA'), 'person', 'Diana Torres', '[{"type":"phone","value":"+573002223344"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_service();
select t.save('sindueno', (public.ingest_lead(t.id('orgA'), '{"name":"Sin Dueño","identifiers":[{"type":"phone","value":"+573003334455"}]}'::jsonb) ->> 'customer_id')::uuid);
select t.reset();

-- ---------------------------------------------------------------------------
-- Crear tareas
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('t1', public.create_task(t.id('orgA'), 'Llamar a Carlos', 'call', now() + interval '1 day', 'high', 'Confirmar demo', t.id('carlos'), null, null));
select t.reset();
select t.ok('la tarea nace abierta, asignada a quien la crea y con su equipo',
  (select status = 'open' and assignee_id = :S1 and team_id = :T1 and customer_id = t.id('carlos') and priority = 'high'
     and type = 'call' and completed_at is null from public.tasks where id = t.id('t1')));

select t.as_user(:S1);
select t.save('t2', public.create_task(t.id('orgA'), 'Enviar propuesta', 'email', null, 'normal', null, null, t.id('opp1'), null));
select t.reset();
select t.ok('vinculada solo a una oportunidad: hereda el cliente de la oportunidad',
  (select customer_id = t.id('carlos') and opportunity_id = t.id('opp1') from public.tasks where id = t.id('t2')));

select t.as_user(:S1); select t.ok('S1 ve sus 2 tareas', (select count(*) from public.tasks) = 2); select t.reset();
select t.as_user(:S2); select t.ok('S2 NO ve tareas ajenas', (select count(*) from public.tasks) = 0); select t.reset();
select t.as_user(:M);  select t.ok('el manager ve todas', (select count(*) from public.tasks) = 2); select t.reset();
select t.as_user(:E);  select t.ok('el sales manager ve las de su equipo', (select count(*) from public.tasks) = 2); select t.reset();
select t.as_user(:V);  select t.ok('viewer no ve tareas', (select count(*) from public.tasks) = 0); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no ve nada', (select count(*) from public.tasks) = 0); select t.reset();

select t.as_user(:S1);
select t.throws('no se puede vincular a un cliente ajeno',
  format('select public.create_task(%L, ''X'', ''call'', null, ''normal'', null, %L, null, null)', t.id('orgA'), t.id('diana')), '42501');
select t.throws('ni a un cliente SIN propietario (regresión: NULL en la comprobación de acceso)',
  format('select public.create_task(%L, ''X'', ''call'', null, ''normal'', null, %L, null, null)', t.id('orgA'), t.id('sindueno')), '42501');
select t.throws('el título no puede estar vacío',
  format('select public.create_task(%L, ''  '', ''call'', null, ''normal'', null, null, null, null)', t.id('orgA')), '22023');
select t.throws('el tipo debe ser válido',
  format('select public.create_task(%L, ''X'', ''telepatia'', null, ''normal'', null, null, null, null)', t.id('orgA')), '23514');
select t.throws('vencimiento absurdo (10 años)',
  format('select public.create_task(%L, ''X'', ''call'', now() + interval ''10 years'', ''normal'', null, null, null, null)', t.id('orgA')), '22023');
select t.throws('vencimiento en el pasado lejano',
  format('select public.create_task(%L, ''X'', ''call'', now() - interval ''2 years'', ''normal'', null, null, null, null)', t.id('orgA')), '22023');
select t.throws('un vendedor no puede asignar tareas a otra persona',
  format('select public.create_task(%L, ''X'', ''call'', null, ''normal'', null, null, null, %L)', t.id('orgA'), :S2), '42501');
select t.reset();
select t.as_user(:V);
select t.throws('un viewer no puede crear tareas', format('select public.create_task(%L, ''X'')', t.id('orgA')), '42501');
select t.reset();
select t.as_user(:B);
select t.throws('B no puede crear tareas en la organización de A', format('select public.create_task(%L, ''X'')', t.id('orgA')), '42501');
select t.reset();

-- Asignación según alcance
select t.as_user(:E);
select t.ok('un sales manager asigna dentro de su equipo',
  (select public.create_task(t.id('orgA'), 'Seguimiento equipo', 'follow_up', null, 'normal', null, null, null, :S1)) is not null);
select t.throws('pero no a otro equipo',
  format('select public.create_task(%L, ''X'', ''follow_up'', null, ''normal'', null, null, null, %L)', t.id('orgA'), :S2), '42501');
select t.reset();
select t.as_user(:M);
select t.save('t_m', public.create_task(t.id('orgA'), 'Revisar cartera', 'other', null, 'low', null, null, null, :S2));
select t.reset();
select t.ok('un manager asigna a cualquiera', (select assignee_id = :S2 and team_id = :T2 from public.tasks where id = t.id('t_m')));
select t.as_user(:M);
select t.throws('el responsable debe ser miembro de la organización',
  format('select public.create_task(%L, ''X'', ''other'', null, ''normal'', null, null, null, %L)', t.id('orgA'), :B), '23514');
select t.reset();

-- ---------------------------------------------------------------------------
-- Editar y reasignar
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.ok('el responsable edita título y vencimiento',
  t.affected($q$update public.tasks set title = 'Llamar a Carlos (demo)', due_at = now() + interval '2 days' where id = {t1}$q$) = 1);
select t.throws('el estado no se escribe directamente', format('update public.tasks set status = ''done'' where id = %L', t.id('t1')), '42501');
select t.throws('completed_at no se escribe directamente', format('update public.tasks set completed_at = now() where id = %L', t.id('t1')), '42501');
select t.throws('un vendedor no puede reasignar una tarea', format('update public.tasks set assignee_id = %L where id = %L', :S2, t.id('t1')), '42501');
select t.throws('INSERT directo denegado', format('insert into public.tasks (org_id, title) values (%L, ''X'')', t.id('orgA')), '42501');
select t.throws('DELETE directo denegado', format('delete from public.tasks where id = %L', t.id('t1')), '42501');
select t.reset();
select t.as_user(:S2);
select t.ok('S2 editando una tarea ajena: 0 filas afectadas', t.affected($q$update public.tasks set title = 'hack' where id = {t1}$q$) = 0);
select t.throws('S2 no puede completar la tarea de S1', format('select public.complete_task(%L)', t.id('t1')), '42501');
select t.reset();
select t.as_user(:M);
select t.ok('el manager reasigna', t.affected($q$update public.tasks set assignee_id = {S2} where id = {t2}$q$) = 1);
select t.throws('a alguien que no es miembro', format('update public.tasks set assignee_id = %L where id = %L', :B, t.id('t2')), '23514');
select t.ok('y devuelve la tarea', t.affected($q$update public.tasks set assignee_id = {S1} where id = {t2}$q$) = 1);
select t.reset();

-- ---------------------------------------------------------------------------
-- Ciclo de vida
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select public.complete_task(t.id('t1'), 'Contestó y agendó demo');
select t.reset();
select t.ok('completar registra fecha, quién y resultado',
  (select status = 'done' and completed_at is not null and completed_by = :S1 and outcome = 'Contestó y agendó demo'
     from public.tasks where id = t.id('t1')));
select t.as_user(:S1);
select t.throws('completar dos veces', format('select public.complete_task(%L)', t.id('t1')), '23514');
select t.throws('una tarea cerrada no se edita', format('update public.tasks set title = ''Otro'' where id = %L', t.id('t1')), '23514');
select public.reopen_task(t.id('t1'));
select t.reset();
select t.ok('reabrir limpia fecha y resultado', (select status = 'open' and completed_at is null and outcome is null from public.tasks where id = t.id('t1')));
select t.as_user(:S1);
select t.throws('reabrir una abierta', format('select public.reopen_task(%L)', t.id('t1')), '23514');
select public.cancel_task(t.id('t1'), 'El cliente ya no lo necesita');
select t.reset();
select t.ok('cancelar', (select status = 'cancelled' and completed_at is null and outcome = 'El cliente ya no lo necesita' from public.tasks where id = t.id('t1')));
select t.as_user(:S1);
select t.throws('una cancelada no se completa', format('select public.complete_task(%L)', t.id('t1')), '23514');
select t.reset();
select t.ok('cada paso emite su evento ligado al cliente',
  (select count(distinct type) = 4 from public.domain_events
    where customer_id = t.id('carlos') and type in ('task.created', 'task.completed', 'task.reopened', 'task.cancelled')));

-- ---------------------------------------------------------------------------
-- Las tareas abiertas siguen al cliente
-- ---------------------------------------------------------------------------
select t.as_user(:M);
select t.save('t_a', public.create_task(t.id('orgA'), 'Abierta del responsable', 'call', null, 'normal', null, t.id('carlos'), null, :S1));
select t.save('t_b', public.create_task(t.id('orgA'), 'Asignada a mano al manager', 'call', null, 'normal', null, t.id('carlos'), null, :M));
select t.reset();
select t.as_user(:S1);
select t.save('t_c', public.create_task(t.id('orgA'), 'Ya hecha', 'call', null, 'normal', null, t.id('carlos'), null, null));
select public.complete_task(t.id('t_c'));
select t.reset();
select t.as_user(:M);
select t.ok('el manager reasigna a Carlos a S2', t.affected($q$update public.customers set owner_id = {S2} where id = {carlos}$q$) = 1);
select t.reset();
select t.ok('la tarea abierta del responsable anterior pasa al nuevo responsable (y su equipo)',
  (select assignee_id = :S2 and team_id = :T2 from public.tasks where id = t.id('t_a')));
select t.ok('la asignada a mano a otra persona NO se toca', (select assignee_id = :M from public.tasks where id = t.id('t_b')));
select t.ok('la ya cerrada tampoco', (select assignee_id = :S1 and status = 'done' from public.tasks where id = t.id('t_c')));
select t.as_user(:M);
select t.ok('el manager devuelve a Carlos a S1', t.affected($q$update public.customers set owner_id = {S1} where id = {carlos}$q$) = 1);
select t.reset();

-- ---------------------------------------------------------------------------
-- Actividades
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('act1', public.log_activity(t.id('carlos'), 'call', 'Habló con Carlos: pide cotización para el plan A', 'outbound', t.id('opp1')));
select t.save('act2', public.log_activity(t.id('carlos'), 'note', 'Prefiere que lo contacten por la tarde'));
select t.save('act3', public.log_activity(t.id('carlos'), 'meeting', 'Reunión en sus oficinas', null, null, now() - interval '2 days'));
select t.ok('el propietario ve sus actividades', (select count(*) from public.activities) = 3);
select t.throws('una llamada requiere dirección (entrante/saliente)', format('select public.log_activity(%L, ''call'', ''sin dirección'')', t.id('carlos')), '23514');
select t.throws('tipo inválido', format('select public.log_activity(%L, ''telepatia'', ''x'', ''inbound'')', t.id('carlos')), '23514');
select t.throws('el resumen no puede estar vacío', format('select public.log_activity(%L, ''note'', ''  '')', t.id('carlos')), '22023');
select t.throws('no se registran actividades en el futuro', format('select public.log_activity(%L, ''note'', ''x'', null, null, now() + interval ''1 day'')', t.id('carlos')), '22023');
select t.throws('ni de hace más de un año', format('select public.log_activity(%L, ''note'', ''x'', null, null, now() - interval ''2 years'')', t.id('carlos')), '22023');
select t.throws('no sobre un cliente ajeno', format('select public.log_activity(%L, ''note'', ''x'')', t.id('diana')), '42501');
select t.throws('NI sobre un cliente SIN propietario (regresión: NULL en la comprobación de acceso)', format('select public.log_activity(%L, ''note'', ''x'')', t.id('sindueno')), '42501');
select t.reset();
select t.as_user(:S2);
select t.ok('S2 no ve las actividades de Carlos', (select count(*) from public.activities) = 0);
select t.throws('y no puede registrar en su ficha', format('select public.log_activity(%L, ''note'', ''x'')', t.id('carlos')), '42501');
select t.reset();
select t.as_user(:V);
select t.throws('un viewer no puede registrar actividades', format('select public.log_activity(%L, ''note'', ''x'')', t.id('carlos')), '42501');
select t.reset();
select t.as_user(:M);
select t.ok('el manager ve todas', (select count(*) from public.activities) = 3);
select t.reset();

-- Una oportunidad de otro cliente no se puede usar como contexto
select t.as_user(:S2);
select t.save('opp_d', public.create_opportunity(t.id('diana'), 'Plan Diana', 10));
select public.log_activity(t.id('diana'), 'note', 'Nota de Diana');
select t.throws('la oportunidad debe ser del mismo cliente',
  format('select public.log_activity(%L, ''note'', ''x'', null, %L)', t.id('diana'), t.id('opp1')), '42501');
select t.reset();

-- Inmutables
select t.throws('una actividad no se modifica', $$update public.activities set summary = 'x'$$, '42501');
select t.throws('ni se borra', $$delete from public.activities$$, '42501');
select t.throws('ni se vacía la tabla', $$truncate public.activities$$, '42501');
select t.as_user(:S1);
select t.throws('los usuarios no insertan directamente', format('insert into public.activities (org_id, customer_id, type, summary) values (%L, %L, ''note'', ''x'')', t.id('orgA'), t.id('carlos')), '42501');
select t.throws('ni modifican', format('update public.activities set summary = ''x'' where id = %L', t.id('act1')), '42501');
select t.reset();

-- Línea de tiempo
select t.as_user(:S1);
select public.log_activity(t.id('carlos'), 'note', repeat('x', 500));
select t.ok('el resumen en el evento se recorta a 140 caracteres',
  (select max(char_length(payload ->> 'summary')) from public.customer_timeline(t.id('carlos'), 200) where type = 'activity.logged') = 140);
select t.ok('la línea de tiempo del cliente incluye tareas y actividades',
  (select count(distinct type) filter (where type in ('task.created', 'task.completed', 'activity.logged')) = 3
     from public.customer_timeline(t.id('carlos'), 200)));
select t.reset();

-- ---------------------------------------------------------------------------
-- Fusión: tareas y actividades del cliente absorbido pasan al principal
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('ester', (public.create_customer(t.id('orgA'), 'person', 'Ester Gil', '[{"type":"phone","value":"+573004445566"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('t_e', public.create_task(t.id('orgA'), 'Tarea de Ester', 'call', null, 'normal', null, t.id('ester'), null, null));
select t.reset();
select t.as_user(:S2);
select t.save('fabio', (public.create_customer(t.id('orgA'), 'person', 'Fabio Ríos', '[{"type":"phone","value":"+573005556677"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('opp_f', public.create_opportunity(t.id('fabio'), 'Plan Fabio', 10));
select t.save('t_f', public.create_task(t.id('orgA'), 'Tarea de Fabio', 'call', null, 'normal', null, t.id('fabio'), null, null));
select t.save('t_fo', public.create_task(t.id('orgA'), 'Tarea vía oportunidad de Fabio', 'email', null, 'normal', null, null, t.id('opp_f'), null));
select t.save('act_f', public.log_activity(t.id('fabio'), 'note', 'Nota de Fabio'));
select t.reset();
select t.as_user(:M);
select public.merge_customers(t.id('ester'), t.id('fabio'));
select t.reset();
select t.ok('las tareas del absorbido (directas y por oportunidad) pasan al cliente principal',
  (select count(*) = 2 and bool_and(customer_id = t.id('ester')) from public.tasks where id in (t.id('t_f'), t.id('t_fo'))));
select t.ok('y las abiertas pasan al responsable del cliente resultante (S1)',
  (select bool_and(assignee_id = :S1) from public.tasks where id in (t.id('t_f'), t.id('t_fo'))));
select t.ok('la actividad del absorbido también (sin alterar su contenido)',
  (select customer_id = t.id('ester') and summary = 'Nota de Fabio' from public.activities where id = t.id('act_f')));
select t.throws('fuera de una fusión, cambiar el cliente de una actividad sigue prohibido',
  format('update public.activities set customer_id = %L where id = %L', t.id('carlos'), t.id('act_f')), '42501');

-- ---------------------------------------------------------------------------
-- Estructura y limpieza
-- ---------------------------------------------------------------------------
select t.ok('todas las tablas de public tienen RLS',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('las funciones internas no son ejecutables por authenticated',
  not has_function_privilege('authenticated', 'app.task_transition(uuid, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.tasks_prepare()', 'EXECUTE'));
delete from public.organizations where id = t.id('orgA');
select t.ok('eliminar la organización elimina tareas y actividades sin errores',
  (select count(*) from public.tasks) = 0 and (select count(*) from public.activities) = 0);

rollback;
\echo ✔ TAREAS: TODAS LAS PRUEBAS PASARON
