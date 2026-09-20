-- Pruebas de oportunidades: visibilidad, transiciones registradas, reglas de cierre, leads, fusión y reasignación.
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
\set MK '''4b000000-0000-0000-0000-00000000000b'''
\set T1 '''11111111-0000-0000-0000-000000000001'''
\set T2 '''22222222-0000-0000-0000-000000000002'''

begin;
\i supabase/tests/support/test_helpers.sql

insert into auth.users (id, email) values
  (:A, 'a@acme.test'), (:B, 'b@beta.test'), (:S1, 's1@acme.test'), (:S2, 's2@acme.test'),
  (:M, 'm@acme.test'), (:E, 'e@acme.test'), (:V, 'v@acme.test'), (:MK, 'mk@acme.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('S2', :S2), ('M', :M), ('E', :E), ('V', :V), ('MK', :MK), ('T1', :T1), ('T2', :T2);

select t.as_user(:A); select t.save('orgA', public.create_organization('Acme', 'acme'));
insert into public.teams (id, org_id, name) values (:T1, t.id('orgA'), 'Bogotá'), (:T2, t.id('orgA'), 'Medellín');
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), u.uid, r.id, u.team
    from (values (:S1::uuid, 'sales_agent', :T1::uuid), (:S2::uuid, 'sales_agent', :T2::uuid), (:M::uuid, 'manager', null::uuid),
                 (:E::uuid, 'sales_manager', :T1::uuid), (:V::uuid, 'viewer', null::uuid), (:MK::uuid, 'marketing', null::uuid)) u(uid, rk, team)
    join public.roles r on r.key = u.rk and r.org_id is null;
select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Beta', 'beta')); select t.reset();

select t.save('pipe', (select id from public.pipelines where org_id = t.id('orgA') and is_default));
select t.save('st_nuevo', (select id from public.pipeline_stages where pipeline_id = t.id('pipe') and name = 'Nueva'));
select t.save('st_prop',  (select id from public.pipeline_stages where pipeline_id = t.id('pipe') and name = 'Cotización'));
select t.save('st_won',   (select id from public.pipeline_stages where pipeline_id = t.id('pipe') and kind = 'won'));
select t.save('st_lost',  (select id from public.pipeline_stages where pipeline_id = t.id('pipe') and kind = 'lost'));

-- Clientes: Carlos (S1), Diana (S2), y uno SIN propietario (como los que entran por API/CSV)
select t.as_user(:S1);
select t.save('carlos', (public.create_customer(t.id('orgA'), 'person', 'Carlos Rodríguez', '[{"type":"phone","value":"+573001112233"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_user(:S2);
select t.save('diana', (public.create_customer(t.id('orgA'), 'person', 'Diana Torres', '[{"type":"phone","value":"+573002223344"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_service();
select t.save('sindueno', (public.ingest_lead(t.id('orgA'), '{"name":"Sin Dueño Uno","identifiers":[{"type":"phone","value":"+573003334455"}],"source":"web"}'::jsonb) ->> 'customer_id')::uuid);
select t.reset();

-- ---------------------------------------------------------------------------
-- Crear oportunidades
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('opp1', public.create_opportunity(t.id('carlos'), 'Plan A', 1500000, null, current_date + 30, 'Producto A'));
select t.reset();
select t.ok('nace en la primera etapa abierta del pipeline por defecto, con la moneda de la organización',
  (select stage_id = t.id('st_nuevo') and status = 'open' and closed_at is null and currency = 'COP' and amount = 1500000
     from public.opportunities where id = t.id('opp1')));
select t.ok('hereda propietario y equipo DEL CLIENTE',
  (select owner_id = :S1 and team_id = :T1 from public.opportunities where id = t.id('opp1')));

select t.as_user(:S1); select t.ok('S1 ve su oportunidad', (select count(*) from public.opportunities) = 1); select t.reset();
select t.as_user(:S2); select t.ok('S2 NO la ve', (select count(*) from public.opportunities) = 0); select t.reset();
select t.as_user(:M);  select t.ok('el manager la ve', (select count(*) from public.opportunities) = 1); select t.reset();
select t.as_user(:E);  select t.ok('el sales manager ve las de su equipo', (select count(*) from public.opportunities) = 1); select t.reset();
select t.as_user(:V);  select t.ok('viewer NO ve oportunidades de clientes que no ve', (select count(*) from public.opportunities) = 0); select t.reset();
select t.as_user(:MK); select t.ok('marketing NO ve oportunidades de clientes que no ve', (select count(*) from public.opportunities) = 0); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no ve nada', (select count(*) from public.opportunities) = 0); select t.reset();

select t.as_user(:S1);
select t.throws('no se puede crear sobre un cliente ajeno',
  format('select public.create_opportunity(%L, ''X'')', t.id('diana')), '42501');
select t.throws('NI sobre un cliente SIN propietario (regresión: NULL en la comprobación de acceso)',
  format('select public.create_opportunity(%L, ''X'')', t.id('sindueno')), '42501');
select t.throws('el título no puede estar vacío', format('select public.create_opportunity(%L, ''  '')', t.id('carlos')), '22023');
select t.throws('el monto no puede ser negativo', format('select public.create_opportunity(%L, ''Neg'', -5)', t.id('carlos')), '23514');
select t.reset();
select t.as_user(:V);
select t.throws('un viewer no puede crear oportunidades', format('select public.create_opportunity(%L, ''X'')', t.id('carlos')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Log de transiciones
-- ---------------------------------------------------------------------------
select t.ok('la creación queda registrada (desde nada hasta la etapa inicial, con quién y por qué vía)',
  (select count(*) = 1 and bool_and(from_state is null and to_state = 'Nueva' and actor_id = :S1 and source = 'user')
     from public.state_transitions where entity_type = 'opportunity' and entity_id = t.id('opp1')));

select t.as_user(:S1);
select public.move_opportunity(t.id('opp1'), t.id('st_prop'));
select t.reset();
select t.ok('mover a otra etapa abierta se registra con el tipo de etapa',
  (select from_state = 'Nueva' and to_state = 'Cotización' and meta ->> 'to_kind' = 'open' and meta ->> 'from_kind' = 'open'
     from public.state_transitions where entity_id = t.id('opp1') order by occurred_at desc, id desc limit 1));
select t.ok('la oportunidad sigue abierta', (select status = 'open' and stage_id = t.id('st_prop') from public.opportunities where id = t.id('opp1')));

select t.as_user(:S1);
select t.ok('S1 ve el historial de su oportunidad', (select count(*) from public.state_transitions where entity_id = t.id('opp1')) = 2);
select t.reset();
select t.as_user(:S2);
select t.ok('S2 NO ve el historial', (select count(*) from public.state_transitions where entity_id = t.id('opp1')) = 0);
select t.throws('S2 no puede mover una oportunidad ajena', format('select public.move_opportunity(%L, %L)', t.id('opp1'), t.id('st_nuevo')), '42501');
select t.reset();

-- Etapas inválidas
select t.as_user(:A);
select t.save('pipe2', public.create_pipeline(t.id('orgA'), 'Otro'));
insert into public.pipeline_stages (org_id, pipeline_id, name, kind, probability) values (t.id('orgA'), t.id('pipe'), 'Vieja', 'open', 5);
select t.save('st_other', (select id from public.pipeline_stages where pipeline_id = t.id('pipe2') and name = 'Nueva'));
select t.save('st_vieja', (select id from public.pipeline_stages where name = 'Vieja'));
update public.pipeline_stages set archived_at = now() where id = t.id('st_vieja');
select t.reset();
select t.as_user(:S1);
select t.throws('no se puede mover a una etapa de OTRO pipeline', format('select public.move_opportunity(%L, %L)', t.id('opp1'), t.id('st_other')), '23514');
select t.throws('ni a una etapa archivada', format('select public.move_opportunity(%L, %L)', t.id('opp1'), t.id('st_vieja')), '23514');
select t.throws('ni a una etapa inexistente', format('select public.move_opportunity(%L, %L)', t.id('opp1'), gen_random_uuid()), '23514');
select t.reset();

-- ---------------------------------------------------------------------------
-- Perder, ganar, reabrir
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.throws('perder exige un motivo', format('select public.move_opportunity(%L, %L)', t.id('opp1'), t.id('st_lost')), '23514');
select t.throws('un motivo de 2 letras no basta', format('select public.move_opportunity(%L, %L, ''ab'')', t.id('opp1'), t.id('st_lost')), '23514');
select public.move_opportunity(t.id('opp1'), t.id('st_lost'), 'Eligió a la competencia por precio');
select t.reset();
select t.ok('perdida: estado, fecha de cierre y motivo',
  (select status = 'lost' and closed_at is not null and lost_reason = 'Eligió a la competencia por precio' from public.opportunities where id = t.id('opp1')));
select t.ok('el motivo también queda en el log',
  (select reason = 'Eligió a la competencia por precio' and meta ->> 'to_kind' = 'lost'
     from public.state_transitions where entity_id = t.id('opp1') order by occurred_at desc, id desc limit 1));

select t.as_user(:S1);
select t.throws('el vendedor NO puede reabrir una oportunidad cerrada', format('select public.move_opportunity(%L, %L)', t.id('opp1'), t.id('st_nuevo')), '42501');
select t.throws('ni editar el monto de una cerrada', format('update public.opportunities set amount = 1 where id = %L', t.id('opp1')), '42501');
select t.reset();
select t.as_user(:M);
select public.move_opportunity(t.id('opp1'), t.id('st_nuevo'));
select t.reset();
select t.ok('el manager la reabre: vuelve a abierta y se limpia el motivo',
  (select status = 'open' and closed_at is null and lost_reason is null from public.opportunities where id = t.id('opp1')));

select t.as_user(:S1);
select public.move_opportunity(t.id('opp1'), t.id('st_won'));
select t.reset();
select t.ok('ganada: estado y fecha de cierre, sin motivo de pérdida',
  (select status = 'won' and closed_at is not null and lost_reason is null from public.opportunities where id = t.id('opp1')));
select t.ok('el historial es una cadena continua: cada "desde" es el "hacia" anterior',
  (select bool_and(from_state is not distinct from prev_to)
     from (select from_state, lag(to_state) over (order by occurred_at, id) as prev_to
             from public.state_transitions where entity_id = t.id('opp1')) x));
select t.ok('y la última etapa del historial es la etapa actual',
  (select (select to_state from public.state_transitions where entity_id = t.id('opp1') order by occurred_at desc, id desc limit 1)
        = (select s.name from public.opportunities o join public.pipeline_stages s on s.id = o.stage_id where o.id = t.id('opp1'))));

-- ---------------------------------------------------------------------------
-- Escrituras directas
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('opp2', public.create_opportunity(t.id('carlos'), 'Plan B', 500000));
select t.ok('editar título y monto de una abierta', t.affected($q$update public.opportunities set title = 'Plan B+', amount = 750000 where id = {opp2}$q$) = 1);
select t.throws('el estado no se escribe directamente', format('update public.opportunities set status = ''won'' where id = %L', t.id('opp2')), '42501');
select t.throws('la etapa no se escribe directamente', format('update public.opportunities set stage_id = %L where id = %L', t.id('st_prop'), t.id('opp2')), '42501');
select t.throws('el propietario no se escribe directamente (sigue al cliente)', format('update public.opportunities set owner_id = %L where id = %L', :S2, t.id('opp2')), '42501');
select t.throws('el cliente no se cambia', format('update public.opportunities set customer_id = %L where id = %L', t.id('diana'), t.id('opp2')), '42501');
select t.throws('INSERT directo denegado', format('insert into public.opportunities (org_id, customer_id, pipeline_id, stage_id, title) values (%L, %L, %L, %L, ''X'')', t.id('orgA'), t.id('carlos'), t.id('pipe'), t.id('st_nuevo')), '42501');
select t.throws('DELETE directo denegado', format('delete from public.opportunities where id = %L', t.id('opp2')), '42501');
select t.reset();

-- El log es append-only
select t.throws('el log no se puede modificar', $$update public.state_transitions set to_state = 'x'$$, '42501');
select t.throws('ni borrar', $$delete from public.state_transitions$$, '42501');
select t.throws('ni vaciar (TRUNCATE)', $$truncate public.state_transitions$$, '42501');
select t.as_user(:S1);
select t.throws('los usuarios no pueden insertar en el log',
  format('insert into public.state_transitions (org_id, entity_type, entity_id, to_state) values (%L, ''opportunity'', %L, ''x'')', t.id('orgA'), t.id('opp2')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Oportunidad sin propietario (cliente sin asignar)
-- ---------------------------------------------------------------------------
select t.as_user(:M);
select t.save('opp_un', public.create_opportunity(t.id('sindueno'), 'Lote sin dueño', 100));
select t.reset();
select t.as_user(:S1);
select t.ok('un vendedor no ve una oportunidad sin propietario', (select count(*) from public.opportunities where id = t.id('opp_un')) = 0);
select t.throws('y no puede moverla (regresión: NULL en la comprobación de acceso)',
  format('select public.move_opportunity(%L, %L)', t.id('opp_un'), t.id('st_prop')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Reasignar el cliente: lo abierto lo sigue; lo cerrado no
-- ---------------------------------------------------------------------------
select t.as_user(:M);
select t.ok('el manager reasigna a Carlos a S2', t.affected($q$update public.customers set owner_id = {S2} where id = {carlos}$q$) = 1);
select t.reset();
select t.ok('la oportunidad ABIERTA sigue al cliente (dueño y equipo)',
  (select owner_id = :S2 and team_id = :T2 from public.opportunities where id = t.id('opp2')));
select t.ok('la GANADA conserva su propietario original',
  (select owner_id = :S1 from public.opportunities where id = t.id('opp1')));
select t.as_user(:S1);
select t.ok('S1 ya no ve la abierta pero sí conserva la ganada', (select count(*) from public.opportunities where id = t.id('opp2')) = 0
  and (select count(*) from public.opportunities where id = t.id('opp1')) = 1);
select t.reset();
select t.as_user(:M);
select t.ok('el manager devuelve a Carlos a S1', t.affected($q$update public.customers set owner_id = {S1} where id = {carlos}$q$) = 1);
select t.reset();

-- ---------------------------------------------------------------------------
-- Campos personalizados en oportunidades
-- ---------------------------------------------------------------------------
select t.as_user(:A);
insert into public.custom_field_definitions (org_id, entity, key, label, type) values (t.id('orgA'), 'opportunity', 'competidor', 'Competidor', 'text');
select t.reset();
select t.as_user(:S1);
select t.ok('valor válido', t.affected($q$update public.opportunities set custom_fields = '{"competidor":"ACME"}' where id = {opp2}$q$) = 1);
select t.throws('clave desconocida', format('update public.opportunities set custom_fields = %L where id = %L', '{"otro":1}', t.id('opp2')), '22023');
select t.reset();

-- ---------------------------------------------------------------------------
-- Archivar con uso
-- ---------------------------------------------------------------------------
select t.as_user(:M);
select t.save('opp_p2', public.create_opportunity(t.id('sindueno'), 'En otro pipeline', 10, t.id('pipe2')));
select t.reset();
select t.as_user(:A);
select t.throws('no se archiva un pipeline con oportunidades abiertas', format('update public.pipelines set archived_at = now() where id = %L', t.id('pipe2')), '23514');
select t.throws('no se archiva una etapa con oportunidades abiertas', format('update public.pipeline_stages set archived_at = now() where id = %L', t.id('st_nuevo')), '23514');
select t.reset();

-- ---------------------------------------------------------------------------
-- Leads: máquina de estados
-- ---------------------------------------------------------------------------
select t.as_service();
select t.save('lead1', (public.ingest_lead(t.id('orgA'), '{"name":"Carlos R","identifiers":[{"type":"phone","value":"+573001112233"}],"source":"web","product_interest":"Producto Web"}'::jsonb) ->> 'lead_id')::uuid);
select t.save('lead2', (public.ingest_lead(t.id('orgA'), '{"name":"Carlos R","identifiers":[{"type":"phone","value":"+573001112233"}],"source":"ig"}'::jsonb) ->> 'lead_id')::uuid);
select t.save('lead3', (public.ingest_lead(t.id('orgA'), '{"name":"Carlos R","identifiers":[{"type":"phone","value":"+573001112233"}],"source":"fb"}'::jsonb) ->> 'lead_id')::uuid);
select t.reset();

select t.ok('todo lead nuevo tiene su estado inicial en el log',
  (select count(*) = 1 and bool_and(from_state is null and to_state = 'new') from public.state_transitions where entity_id = t.id('lead1')));

select t.as_user(:S1);
select public.set_lead_status(t.id('lead1'), 'contacted');
select t.ok('nuevo → contactado', (select status = 'contacted' from public.leads where id = t.id('lead1')));
select t.throws('descartar exige motivo', format('select public.set_lead_status(%L, ''disqualified'')', t.id('lead1')), '23514');
select public.set_lead_status(t.id('lead1'), 'disqualified', 'Sin presupuesto');
select t.ok('descartado con motivo (queda en el lead y en el log)',
  (select l.status = 'disqualified' and l.disqualified_reason = 'Sin presupuesto' from public.leads l where l.id = t.id('lead1'))
  and (select reason = 'Sin presupuesto' from public.state_transitions where entity_id = t.id('lead1') order by occurred_at desc, id desc limit 1));
select public.set_lead_status(t.id('lead1'), 'new');
select t.ok('reactivar limpia el motivo', (select status = 'new' and disqualified_reason is null from public.leads where id = t.id('lead1')));
select t.throws('convertir se hace con convert_lead, no con set_lead_status', format('select public.set_lead_status(%L, ''converted'')', t.id('lead1')), '22023');
select t.throws('un estado inexistente', format('select public.set_lead_status(%L, ''foo'')', t.id('lead1')), '23514');
select t.throws('el estado no se escribe directamente', format('update public.leads set status = ''qualified'' where id = %L', t.id('lead1')), '42501');
select t.reset();
select t.as_user(:S2);
select t.throws('S2 no puede cambiar el estado del lead de S1', format('select public.set_lead_status(%L, ''contacted'')', t.id('lead2')), '42501');
select t.reset();

-- Convertir
select t.as_user(:S1);
select t.save('opp_conv', public.convert_lead(t.id('lead1')));
select t.reset();
select t.ok('el lead queda convertido y apunta a la oportunidad',
  (select status = 'converted' and converted_opportunity_id = t.id('opp_conv') from public.leads where id = t.id('lead1')));
select t.ok('la oportunidad usa el interés del lead como título y es del cliente',
  (select title = 'Producto Web' and customer_id = t.id('carlos') and owner_id = :S1 from public.opportunities where id = t.id('opp_conv')));
select t.ok('el log del lead cuenta la historia completa y EN ORDEN: nuevo → contactado → descartado → nuevo → calificado → convertido',
  (select array_agg(to_state order by occurred_at, id) = array['new', 'contacted', 'disqualified', 'new', 'qualified', 'converted']
     from public.state_transitions where entity_type = 'lead' and entity_id = t.id('lead1')));
select t.as_user(:S1);
select t.throws('un lead ya convertido no se convierte de nuevo', format('select public.convert_lead(%L)', t.id('lead1')), '23514');
select public.set_lead_status(t.id('lead2'), 'disqualified', 'Duplicado de otro');
select t.throws('un lead descartado no se convierte', format('select public.convert_lead(%L)', t.id('lead2')), '23514');
select t.reset();
select t.as_user(:S2);
select t.throws('S2 no puede convertir el lead de S1', format('select public.convert_lead(%L)', t.id('lead3')), '42501');
select t.reset();
select t.as_user(:V);
select t.throws('un viewer no puede convertir', format('select public.convert_lead(%L)', t.id('lead3')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Línea de tiempo y eventos
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.ok('la línea de tiempo del cliente incluye los eventos de la oportunidad',
  (select count(distinct type) filter (where type in ('opportunity.created', 'opportunity.won', 'opportunity.stage_changed', 'lead.status_changed')) = 4
     from public.customer_timeline(t.id('carlos'), 200)));
select t.reset();
select t.ok('el orden cronológico es real dentro de una transacción: «cliente creado» es ESTRICTAMENTE anterior a «lead recibido»',
  (select c.occurred_at < l.occurred_at
     from public.domain_events c, public.domain_events l
    where c.customer_id = t.id('sindueno') and c.type = 'customer.created'
      and l.customer_id = t.id('sindueno') and l.type = 'lead.created'));

-- ---------------------------------------------------------------------------
-- Fusión: las oportunidades del cliente absorbido pasan al principal
-- ---------------------------------------------------------------------------
select t.as_user(:S2);
select t.save('opp_diana', public.create_opportunity(t.id('diana'), 'Plan Diana', 900));
select t.reset();
select t.as_user(:M);
select public.merge_customers(t.id('carlos'), t.id('diana'));
select t.reset();
select t.ok('la oportunidad de Diana ahora es del cliente principal y sigue a su responsable',
  (select customer_id = t.id('carlos') and owner_id = :S1 from public.opportunities where id = t.id('opp_diana')));
select t.as_user(:S1);
select t.ok('S1 la ve, junto con su historial', (select count(*) from public.opportunities where id = t.id('opp_diana')) = 1
  and (select count(*) from public.state_transitions where entity_id = t.id('opp_diana')) = 1);
select t.reset();

-- ---------------------------------------------------------------------------
-- Matriz de permisos derivados (§12): nadie ve más oportunidades que clientes
-- ---------------------------------------------------------------------------
select t.ok('marketing, servicio al cliente, analista y viewer NO tienen alcance org sobre datos derivados del cliente',
  (select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id
    where r.org_id is null and r.key in ('marketing', 'customer_service', 'analyst', 'viewer')
      and rp.permission_key ~ '^(opportunities|quotes|sales|conversations|tasks|cases):' and rp.scope = 'org') = 0);
select t.ok('el vendedor solo tiene alcance propio y el sales manager solo de equipo sobre oportunidades y tareas',
  (select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id
    where r.org_id is null and rp.permission_key ~ '^(opportunities|tasks):'
      and ((r.key = 'sales_agent' and rp.scope <> 'own') or (r.key = 'sales_manager' and rp.scope <> 'team'))) = 0);

-- ---------------------------------------------------------------------------
-- Estructura y limpieza
-- ---------------------------------------------------------------------------
select t.ok('todas las tablas de public tienen RLS',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('la auditoría no guarda datos crudos de los leads',
  (select count(*) from public.audit_logs where new_values ? 'raw_payload' or old_values ? 'raw_payload') = 0);
delete from public.organizations where id = t.id('orgA');
select t.ok('eliminar una organización con oportunidades, transiciones y tareas no viola FKs ni el log append-only',
  (select count(*) from public.state_transitions) = 0 and (select count(*) from public.opportunities) = 0);

rollback;
\echo ✔ OPORTUNIDADES: TODAS LAS PRUEBAS PASARON
