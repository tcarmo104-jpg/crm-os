-- Pruebas de 0026: Automatizaciones (disparadas por eventos que YA existen, actuando con la identidad
-- de quien creó la regla, ejecutadas «como si» las llamara el despachador real).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-c606-0000-0000-00000000000a'''
\set S1 '''51000000-c606-0000-0000-000000000001'''
\set V1 '''6a000000-c606-0000-0000-00000000000a'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@au.test'), (:S1, 's1@au.test'), (:V1, 'v1@au.test');
select t.as_user(:A); select t.save('org', public.create_organization('Automatizaciones Test', 'automatizaciones-test'));
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :S1::uuid, r.id from public.roles r where r.key = 'sales_manager' and r.org_id is null;
insert into public.memberships (org_id, user_id, role_id) select t.id('org'), :V1::uuid, r.id from public.roles r where r.key = 'viewer' and r.org_id is null;
select t.save('cust', (public.create_customer(t.id('org'), 'person', 'Cliente Automatización', '[{"type":"phone","value":"+573001110095"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();

-- ---- Crear una regla (solo automations:manage)
select t.as_user(:S1);
select t.throws('un sales_manager NO puede crear una regla (solo automations:read, no manage)',
  format('select public.create_automation_rule(%L, ''Bienvenida'', ''lead.created'', ''[]''::jsonb, ''[{"type":"add_tag","name":"Nuevo lead"}]''::jsonb)', t.id('org')), '42501');
select t.reset();

select t.as_user(:A); -- super_admin: tiene automations:manage
select t.save('rule', public.create_automation_rule(t.id('org'), 'Etiquetar leads de feria', 'lead.created',
  '[{"field":"source","op":"eq","value":"feria"}]'::jsonb, '[{"type":"add_tag","name":"Feria"}]'::jsonb));
select t.reset();
select t.ok('crea la regla activa, con su disparador y condición', (select is_active and trigger = 'lead.created' from public.automation_rules where id = t.id('rule')));

select t.as_user(:A);
select t.throws('una regla necesita al menos una acción', format('select public.create_automation_rule(%L, ''X'', ''lead.created'', ''[]''::jsonb, ''[]''::jsonb)', t.id('org')), '22023');
select t.throws('un disparador desconocido se rechaza', format('select public.create_automation_rule(%L, ''X'', ''volar'', ''[]''::jsonb, ''[{"type":"add_tag","name":"x"}]''::jsonb)', t.id('org')), '23514');
select t.reset();

-- ---- Ejecutar: la condición SÍ se cumple → etiqueta al cliente
create table t.res_text (k text primary key, v text); grant all on table t.res_text to public;
select t.as_service();
select t.save('lead1', gen_random_uuid());
select t.save('ev1id', app.emit_event(t.id('org'), 'lead.created', 'lead', t.id('lead1'), jsonb_build_object('source', 'feria'), t.id('cust')));
insert into t.res_text select 'ev1', (public.run_automation_rule(t.id('rule'), t.id('ev1id'),
  jsonb_build_object('customer_id', t.id('cust'), 'entity_type', 'lead', 'entity_id', t.id('lead1'),
                      'payload', jsonb_build_object('source', 'feria'))) ->> 'status');
select t.reset();
select t.ok('la acción se ejecutó: el cliente queda etiquetado «Feria»', (select count(*) = 1 from tags tg join customer_tags ct on ct.tag_id = tg.id where ct.customer_id = t.id('cust') and tg.name = 'Feria'));
select t.ok('queda registrada como «ok» en el historial', (select status = 'ok' from public.automation_runs where rule_id = t.id('rule') limit 1));

-- ---- La condición NO se cumple → no hace nada, y queda registrada como «omitida»
select t.as_service();
select t.save('lead2', gen_random_uuid());
select t.save('ev2id', app.emit_event(t.id('org'), 'lead.created', 'lead', t.id('lead2'), jsonb_build_object('source', 'instagram'), t.id('cust')));
insert into t.res_text select 'ev2', (public.run_automation_rule(t.id('rule'), t.id('ev2id'),
  jsonb_build_object('customer_id', t.id('cust'), 'entity_type', 'lead', 'entity_id', t.id('lead2'),
                      'payload', jsonb_build_object('source', 'instagram'))) ->> 'status');
select t.reset();
select t.ok('con una fuente distinta, la condición no se cumple: queda «skipped»', (select v = 'skipped' from t.res_text where k = 'ev2'));
select t.ok('sigue habiendo una sola etiqueta (no se repitió)', (select count(*) = 1 from tags tg join customer_tags ct on ct.tag_id = tg.id where ct.customer_id = t.id('cust') and tg.name = 'Feria'));

-- ---- El MISMO evento no vuelve a disparar la MISMA regla (idempotencia: así el despachador puede reintentar)
select t.as_service();
select t.save('same_event', app.emit_event(t.id('org'), 'lead.created', 'lead', gen_random_uuid(), jsonb_build_object('source', 'feria'), t.id('cust')));
select public.run_automation_rule(t.id('rule'), t.id('same_event'), jsonb_build_object('customer_id', t.id('cust'), 'payload', jsonb_build_object('source', 'feria')));
insert into t.res_text select 'ev3', (public.run_automation_rule(t.id('rule'), t.id('same_event'), jsonb_build_object('customer_id', t.id('cust'), 'payload', jsonb_build_object('source', 'feria'))) ->> 'status');
select t.reset();
select t.ok('reintentar el MISMO id de evento no vuelve a ejecutar la acción', (select v = 'skipped' from t.res_text where k = 'ev3'));
select t.ok('sigue habiendo una sola etiqueta', (select count(*) = 1 from tags tg join customer_tags ct on ct.tag_id = tg.id where ct.customer_id = t.id('cust') and tg.name = 'Feria'));

-- ---- Una regla inactiva no hace nada
select t.as_user(:A); select public.set_automation_active(t.id('rule'), false); select t.reset();
select t.as_service();
select t.save('ev4id', app.emit_event(t.id('org'), 'lead.created', 'lead', gen_random_uuid(), jsonb_build_object('source', 'feria'), t.id('cust')));
insert into t.res_text select 'ev4', (public.run_automation_rule(t.id('rule'), t.id('ev4id'), jsonb_build_object('customer_id', t.id('cust'), 'payload', jsonb_build_object('source', 'feria'))) ->> 'status');
select t.reset();
select t.ok('regla inactiva: no se ejecuta', (select v = 'skipped' from t.res_text where k = 'ev4'));
select t.as_user(:A); select public.set_automation_active(t.id('rule'), true); select t.reset();

-- ---- Otra regla: crear una tarea (acción distinta), sin condiciones (siempre aplica)
select t.as_user(:A);
select t.save('rule2', public.create_automation_rule(t.id('org'), 'Tarea al ganar', 'opportunity.won', '[]'::jsonb,
  '[{"type":"create_task","title":"Enviar encuesta de satisfacción","taskType":"email","offsetDays":1}]'::jsonb));
select t.reset();
select t.reset();
select t.as_user(:A); select t.save('opp1', public.create_opportunity(t.id('cust'), 'Oportunidad de prueba', 12000000)); select t.reset();
select t.as_service();
select t.save('ev5id', app.emit_event(t.id('org'), 'opportunity.won', 'opportunity', t.id('opp1'), '{}'::jsonb, t.id('cust')));
select public.run_automation_rule(t.id('rule2'), t.id('ev5id'), jsonb_build_object('customer_id', t.id('cust'), 'entity_type', 'opportunity', 'entity_id', t.id('opp1'), 'payload', '{}'::jsonb));
select t.reset();
select t.ok('crea la tarea, con el responsable = quien creó la regla, y vence ~1 día después',
  (select count(*) = 1 and bool_and(assignee_id = :A::uuid) and bool_and(due_at::date = (current_date + 1)) from public.tasks where customer_id = t.id('cust') and title = 'Enviar encuesta de satisfacción'));

-- ---- Condiciones numéricas (monto de la oportunidad)
select t.as_user(:A);
select t.save('rule3', public.create_automation_rule(t.id('org'), 'Alerta de oportunidad grande', 'opportunity.won',
  '[{"field":"amount","op":"gte","value":"10000000"}]'::jsonb, '[{"type":"add_tag","name":"Venta grande"}]'::jsonb));
select t.reset();
select t.as_service();
select t.save('ev6id', app.emit_event(t.id('org'), 'opportunity.won', 'opportunity', gen_random_uuid(), jsonb_build_object('amount', 5000000), t.id('cust')));
select t.save('ev7id', app.emit_event(t.id('org'), 'opportunity.won', 'opportunity', gen_random_uuid(), jsonb_build_object('amount', 15000000), t.id('cust')));
select public.run_automation_rule(t.id('rule3'), t.id('ev6id'), jsonb_build_object('customer_id', t.id('cust'), 'payload', jsonb_build_object('amount', '5000000')));
select public.run_automation_rule(t.id('rule3'), t.id('ev7id'), jsonb_build_object('customer_id', t.id('cust'), 'payload', jsonb_build_object('amount', '15000000')));
select t.reset();
select t.ok('monto menor: no etiqueta; monto mayor o igual: sí etiqueta', (select count(*) = 1 from tags tg join customer_tags ct on ct.tag_id = tg.id where ct.customer_id = t.id('cust') and tg.name = 'Venta grande'));

-- ---- Solo quien tiene automations:read ve el historial de una regla
select t.as_user(:V1); select t.ok('un viewer no ve las ejecuciones (sin automations:read)', (select count(*) = 0 from public.automation_runs where rule_id = t.id('rule'))); select t.reset();
select t.as_user(:S1); select t.ok('un sales_manager SÍ ve el historial (tiene automations:read)', (select count(*) > 0 from public.automation_runs where rule_id = t.id('rule'))); select t.reset();

-- ---- `app.run_automation_rule` no es invocable por una persona autenticada (solo el despachador)
select t.as_service(); select t.save('ev8id', app.emit_event(t.id('org'), 'lead.created', 'lead', gen_random_uuid(), '{}'::jsonb, t.id('cust'))); select t.reset();
select t.as_user(:A); select t.throws('una persona autenticada no puede llamar la función de ejecución directamente', format('select app.run_automation_rule(%L, %L, ''{}''::jsonb)', t.id('rule'), t.id('ev8id')), '42501'); select t.reset();

rollback;
\echo ✔ AUTOMATIZACIONES: TODAS LAS PRUEBAS PASARON
