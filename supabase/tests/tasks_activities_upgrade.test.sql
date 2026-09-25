-- Pruebas de 0023: estado «en progreso» de tareas y tipo «visita» en tareas y actividades.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-c202-0000-0000-00000000000a'''
\set B '''bbbbbbbb-c202-0000-0000-00000000000b'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@tu.test'), (:B, 'b@tu.test');
select t.as_user(:A); select t.save('org', public.create_organization('Tareas Up', 'tareas-up'));
select t.save('cust', (public.create_customer(t.id('org'), 'person', 'Cliente Up', '[{"type":"phone","value":"+573001110099"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('task', public.create_task(t.id('org'), 'Visitar oficina', 'visit', null, 'high', null, t.id('cust'), null, null));
select t.reset();

select t.ok('nace abierta', (select status = 'open' and type = 'visit' from public.tasks where id = t.id('task')));
select t.as_user(:A); select public.start_task(t.id('task')); select t.reset();
select t.ok('pasa a «en progreso»; conserva el resultado (aún ninguno) y no queda completada', (select status = 'in_progress' and completed_at is null from public.tasks where id = t.id('task')));

select t.as_user(:A); select t.throws('en progreso no puede volver a "empezar"', format('select public.start_task(%L)', t.id('task')), '23514'); select t.reset();

select t.as_user(:A); select public.complete_task(t.id('task'), 'Visita realizada'); select t.reset();
select t.ok('desde «en progreso» se completa igual que desde «abierta»', (select status = 'done' and completed_at is not null and outcome = 'Visita realizada' from public.tasks where id = t.id('task')));

select t.as_user(:A); select public.reopen_task(t.id('task')); select t.reset();
select t.ok('reabrir una completada vuelve a «abierta» (no a «en progreso»)', (select status = 'open' and completed_at is null and outcome is null from public.tasks where id = t.id('task')));

select t.as_user(:A); select public.start_task(t.id('task')); select public.cancel_task(t.id('task'), 'Ya no aplica'); select t.reset();
select t.ok('desde «en progreso» también se cancela', (select status = 'cancelled' and outcome = 'Ya no aplica' from public.tasks where id = t.id('task')));

select t.as_user(:A); select t.throws('una cancelada no puede «empezar»', format('select public.start_task(%L)', t.id('task')), '23514'); select t.reset();

select t.as_user(:A);
select t.save('task2', public.create_task(t.id('org'), 'Sin empezar', 'call', null, 'normal', null, t.id('cust'), null, null));
select public.complete_task(t.id('task2'));
select t.reset();
select t.ok('compatibilidad: completar directo desde «abierta» (sin pasar por «en progreso») sigue funcionando', (select status = 'done' from public.tasks where id = t.id('task2')));

select t.as_user(:A);
select t.throws('el tipo de tarea solo acepta los valores conocidos', format('select public.create_task(%L, ''x'', ''brincos'', null, ''normal'', null, %L, null, null)', t.id('org'), t.id('cust')), '23514');
select t.throws('el estado no se escribe directo (solo por RPC)', format('update public.tasks set status = %L where id = %L', 'archivada', t.id('task2')), '42501');
select public.log_activity(t.id('cust'), 'visit', 'Visita de seguimiento al showroom');
select t.reset();
select t.ok('una actividad de tipo «visita» se registra igual que las demás', (select count(*) = 1 from public.activities where customer_id = t.id('cust') and type = 'visit'));
select t.as_user(:A); select t.throws('el tipo de actividad tampoco acepta cualquier texto', format('select public.log_activity(%L, ''brincos'', ''texto'')', t.id('cust')), '23514'); select t.reset();

rollback;
\echo ✔ TAREAS Y ACTIVIDADES (0023): TODAS LAS PRUEBAS PASARON
