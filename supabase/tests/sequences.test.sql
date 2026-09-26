-- Pruebas de 0025: Secuencias de seguimiento (sin cron: cada paso avanza al completar el anterior).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-c505-0000-0000-00000000000a'''
\set S1 '''51000000-c505-0000-0000-000000000001'''
\set V1 '''6a000000-c505-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@sq.test'), (:S1, 's1@sq.test'), (:V1, 'v1@sq.test');
select t.as_user(:A); select t.save('org', public.create_organization('Secuencias Test', 'secuencias-test'));
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :S1::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :V1::uuid, r.id from public.roles r where r.key = 'viewer' and r.org_id is null;
select t.save('cust', (public.create_customer(t.id('org'), 'person', 'Cliente Secuencia', '[{"type":"phone","value":"+573001110090"}]'::jsonb) ->> 'customer_id')::uuid);
update public.customers set owner_id = :S1::uuid where id = t.id('cust');
select t.reset();

-- ---- Crear una plantilla (solo quien tiene sequences:manage: manager, no un vendedor)
select t.as_user(:S1);
select t.throws('un vendedor NO puede crear una plantilla (solo sequences:read)',
  format('select public.create_sequence(%L, ''Bienvenida'', null, ''[{"title":"Llamar","type":"call","offsetDays":0}]''::jsonb)', t.id('org')), '42501');
select t.reset();

select t.as_user(:A); -- super_admin de su propia organización: tiene sequences:manage
select t.save('seq', public.create_sequence(t.id('org'), 'Bienvenida a un cliente nuevo', 'Primeros contactos', $j$[
  {"title": "Llamar para dar la bienvenida", "type": "call", "offsetDays": 0, "priority": "high"},
  {"title": "Enviar catálogo por WhatsApp", "type": "whatsapp", "offsetDays": 2},
  {"title": "Confirmar si tiene dudas", "type": "email", "offsetDays": 5}
]$j$::jsonb));
select t.reset();
select t.ok('crea la secuencia con sus 3 pasos en orden', (select count(*) = 3 from public.sequence_steps where sequence_id = t.id('seq')));
select t.ok('el primer paso es el de offset 0 y prioridad alta', (select title = 'Llamar para dar la bienvenida' and priority = 'high' from public.sequence_steps where sequence_id = t.id('seq') and position = 1));

select t.as_user(:A);
select t.throws('una secuencia necesita al menos un paso', format('select public.create_sequence(%L, ''Vacía'', null, ''[]''::jsonb)', t.id('org')), '22023');
select t.throws('una secuencia necesita nombre', format('select public.create_sequence(%L, '''', null, ''[{"title":"x","type":"call"}]''::jsonb)', t.id('org')), '22023');
select t.reset();

-- ---- Inscribir a un cliente (un vendedor SÍ puede: solo necesita sequences:read + poder actualizar ese cliente)
select t.as_user(:S1);
select t.save('enr', public.enroll_in_sequence(t.id('seq'), t.id('cust'), null, null));
select t.reset();
select t.ok('la inscripción queda activa, en el paso 1, y crea la tarea del primer paso',
  (select status = 'active' and current_step = 1 and current_task_id is not null from public.sequence_enrollments where id = t.id('enr')));
select t.ok('la tarea del primer paso tiene el título, tipo y prioridad correctos, y vence hoy (offset 0)',
  (select title = 'Llamar para dar la bienvenida' and type = 'call' and priority = 'high' and due_at::date = current_date
   from public.tasks where id = (select current_task_id from public.sequence_enrollments where id = t.id('enr'))));

select t.as_user(:S1);
select t.throws('no se puede inscribir dos veces la misma secuencia activa en el mismo cliente',
  format('select public.enroll_in_sequence(%L, %L, null, null)', t.id('seq'), t.id('cust')), '23505');
select t.reset();

-- ---- Completar el paso 1 avanza SOLA a la 2 (sin cron: lo dispara task_transition)
select t.as_user(:S1);
select public.complete_task((select current_task_id from public.sequence_enrollments where id = t.id('enr')), 'Contestó, muy contento');
select t.reset();
select t.ok('al completar la tarea, la inscripción avanza al paso 2 con una tarea nueva (offset +2 días)',
  (select current_step = 2 and current_task_id is not null and status = 'active' from public.sequence_enrollments where id = t.id('enr')));
select t.ok('la nueva tarea es la del paso 2 (WhatsApp) y vence ~2 días después',
  (select type = 'whatsapp' and due_at::date = (current_date + 2) from public.tasks where id = (select current_task_id from public.sequence_enrollments where id = t.id('enr'))));

-- ---- Pausar detiene el avance; completar una tarea de una inscripción pausada no hace nada raro
select t.as_user(:S1);
select public.pause_enrollment(t.id('enr'));
select t.reset();
select t.ok('queda pausada', (select status = 'paused' from public.sequence_enrollments where id = t.id('enr')));
select t.as_user(:S1); select t.throws('no se puede pausar una ya pausada', format('select public.pause_enrollment(%L)', t.id('enr')), '23514'); select t.reset();
select t.as_user(:S1); select public.resume_enrollment(t.id('enr')); select t.reset();
select t.ok('reanudada queda activa de nuevo', (select status = 'active' from public.sequence_enrollments where id = t.id('enr')));

-- ---- Completar el último paso completa la inscripción entera (no crea una tarea de más)
select t.as_user(:S1);
select public.complete_task((select current_task_id from public.sequence_enrollments where id = t.id('enr')));
select t.reset();
select t.ok('avanza al paso 3 (el último)', (select current_step = 3 from public.sequence_enrollments where id = t.id('enr')));
select t.as_user(:S1);
select public.complete_task((select current_task_id from public.sequence_enrollments where id = t.id('enr')));
select t.reset();
select t.ok('al completar el último paso, la inscripción queda «completada», sin tarea pendiente',
  (select status = 'completed' and current_task_id is null and finished_at is not null from public.sequence_enrollments where id = t.id('enr')));

-- ---- Cancelar la tarea del paso actual cancela la inscripción entera (no avanza)
select t.as_user(:S1);
select t.save('enr2', public.enroll_in_sequence(t.id('seq'), t.id('cust'), null, null));
select t.reset();
select t.as_user(:S1);
select public.cancel_task((select current_task_id from public.sequence_enrollments where id = t.id('enr2')));
select t.reset();
select t.ok('cancelar la tarea del paso actual cancela la inscripción (no crea el paso siguiente)',
  (select status = 'cancelled' from public.sequence_enrollments where id = t.id('enr2')));

-- ---- Cancelar/pausar directamente la inscripción
select t.as_user(:S1);
select t.save('enr3', public.enroll_in_sequence(t.id('seq'), t.id('cust'), null, null));
select public.cancel_enrollment(t.id('enr3'));
select t.reset();
select t.ok('cancelar la inscripción directamente también funciona', (select status = 'cancelled' from public.sequence_enrollments where id = t.id('enr3')));
select t.as_user(:S1); select t.throws('no se puede cancelar una ya cancelada', format('select public.cancel_enrollment(%L)', t.id('enr3')), '23514'); select t.reset();

-- ---- Un viewer no puede inscribir a nadie
select t.as_user(:V1); select t.throws('un viewer no puede inscribir (sin permiso sobre el cliente)', format('select public.enroll_in_sequence(%L, %L, null, null)', t.id('seq'), t.id('cust')), '42501'); select t.reset();

-- ---- Tampoco puede pausar, reanudar ni cancelar una inscripción de un cliente que no puede tocar
select t.as_user(:S1); select t.save('enr5', public.enroll_in_sequence(t.id('seq'), t.id('cust'), null, null)); select t.reset();
select t.as_user(:V1); select t.throws('un viewer no puede pausar una inscripción ajena', format('select public.pause_enrollment(%L)', t.id('enr5')), '42501'); select t.reset();
select t.as_user(:V1); select t.throws('un viewer no puede cancelar una inscripción ajena', format('select public.cancel_enrollment(%L)', t.id('enr5')), '42501'); select t.reset();

-- ---- Archivar una plantilla: ya no se puede inscribir, pero las inscripciones existentes no se tocan
select t.as_user(:A); select public.archive_sequence(t.id('seq'), false); select t.reset();
select t.as_user(:S1); select t.throws('no se puede inscribir en una secuencia archivada', format('select public.enroll_in_sequence(%L, %L, null, null)', t.id('seq'), t.id('cust')), '42501'); select t.reset();

-- ---- Al fusionar dos clientes, sus inscripciones de secuencia siguen al que sobrevive (registro app.customer_merge_targets)
select t.as_user(:A); select public.archive_sequence(t.id('seq'), true); select t.reset();
select t.as_user(:S1);
select t.save('cust2', (public.create_customer(t.id('org'), 'person', 'Cliente Secuencia Dos', '[{"type":"phone","value":"+573001110091"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('enr4', public.enroll_in_sequence(t.id('seq'), t.id('cust2'), null, null));
select t.reset();
select t.as_user(:A); select public.merge_customers(t.id('cust'), t.id('cust2')); select t.reset();
select t.ok('tras la fusión, la inscripción del cliente absorbido ahora pertenece al que sobrevive',
  (select customer_id = t.id('cust') from public.sequence_enrollments where id = t.id('enr4')));

rollback;
\echo ✔ SECUENCIAS: TODAS LAS PRUEBAS PASARON
