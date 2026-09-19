-- Pruebas de ventas, postventa y casos: foto inmutable, permisos, anulación, seguimiento y visibilidad.
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
\set CS '''c5000000-0000-0000-0000-0000000000c5'''
\set T1 '''11111111-0000-0000-0000-000000000001'''
\set T2 '''22222222-0000-0000-0000-000000000002'''

begin;
\i supabase/tests/support/test_helpers.sql
create table t.res (k text primary key, v jsonb);
grant all on t.res to public;

insert into auth.users (id, email) values
  (:A, 'a@acme.test'), (:B, 'b@beta.test'), (:S1, 's1@acme.test'), (:S2, 's2@acme.test'),
  (:M, 'm@acme.test'), (:E, 'e@acme.test'), (:V, 'v@acme.test'), (:CS, 'cs@acme.test');
insert into t.ctx values ('A', :A), ('B', :B), ('S1', :S1), ('S2', :S2), ('M', :M), ('E', :E), ('V', :V), ('CS', :CS), ('T1', :T1), ('T2', :T2);

select t.as_user(:A); select t.save('orgA', public.create_organization('Acme', 'acme'));
insert into public.teams (id, org_id, name) values (:T1, t.id('orgA'), 'Bogotá'), (:T2, t.id('orgA'), 'Medellín');
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('orgA'), u.uid, r.id, u.team
    from (values (:S1::uuid, 'sales_agent', :T1::uuid), (:S2::uuid, 'sales_agent', :T2::uuid), (:M::uuid, 'manager', null::uuid),
                 (:E::uuid, 'sales_manager', :T1::uuid), (:V::uuid, 'viewer', null::uuid), (:CS::uuid, 'customer_service', null::uuid)) u(uid, rk, team)
    join public.roles r on r.key = u.rk and r.org_id is null;
select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Beta', 'beta')); select t.reset();

-- Datos comerciales: Carlos (S1) con una cotización ACEPTADA
select t.as_user(:S1);
select t.save('carlos', (public.create_customer(t.id('orgA'), 'person', 'Carlos Rodríguez', '[{"type":"phone","value":"+573001112233"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('opp1', public.create_opportunity(t.id('carlos'), 'Plan A', 1));
select t.save('q1', public.create_quote(t.id('opp1')));
select public.add_quote_item(t.id('q1'), null, 'Servicio', 2, 100000, 0, 19);
select public.add_quote_item(t.id('q1'), null, 'Producto', 3, 250000, 10, 19);
select public.send_quote(t.id('q1'));
select public.accept_quote(t.id('q1'));
select t.save('opp1b', public.create_opportunity(t.id('carlos'), 'Otro plan', 1));
select t.save('q1b', public.create_quote(t.id('opp1b')));
select public.add_quote_item(t.id('q1b'), null, 'Algo', 1, 100, 0, 0);
select public.send_quote(t.id('q1b'));
select t.reset();
select t.as_user(:S2);
select t.save('diana', (public.create_customer(t.id('orgA'), 'person', 'Diana Torres', '[{"type":"phone","value":"+573002223344"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();

-- ---------------------------------------------------------------------------
-- Quién puede registrar una venta
-- ---------------------------------------------------------------------------
select t.ok('DECISIÓN DE NEGOCIO fijada: el vendedor NO tiene permiso sales:create (la venta la registra un manager, admin o sales manager)',
  not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id
               where r.org_id is null and r.key = 'sales_agent' and rp.permission_key in ('sales:create', 'sales:update')));
select t.as_user(:S1); select t.throws('un vendedor no registra ventas', format('select public.create_sale(%L)', t.id('q1')), '42501'); select t.reset();
select t.as_user(:S2); select t.throws('menos aún sobre la cotización de otro', format('select public.create_sale(%L)', t.id('q1')), '42501'); select t.reset();
select t.as_user(:V);  select t.throws('un viewer tampoco', format('select public.create_sale(%L)', t.id('q1')), '42501'); select t.reset();
select t.as_user(:B);  select t.throws('otra organización tampoco', format('select public.create_sale(%L)', t.id('q1')), '42501'); select t.reset();
select t.as_user(:E);
select t.throws('solo de una cotización ACEPTADA (la enviada no basta)', format('select public.create_sale(%L)', t.id('q1b')), '23514');
select t.reset();

-- ---------------------------------------------------------------------------
-- Registrar la venta
-- ---------------------------------------------------------------------------
select t.as_user(:E);
select t.save('sale1', public.create_sale(t.id('q1')));
select t.reset();
select t.ok('la venta guarda la FOTO de la cotización (totales) y queda confirmada',
  (select number = 'VTA-0001' and status = 'confirmed' and subtotal = 950000 and discount_total = 75000 and tax_total = 166250
      and total = 1041250 and currency = 'COP' and owner_id = :S1 and customer_id = t.id('carlos') and sold_by = :E
     from public.sales where id = t.id('sale1')));
select t.ok('copia las líneas tal cual (2 líneas, mismos importes)',
  (select count(*) = 2 and sum(line_total) = 1041250 and bool_or(description = 'Producto' and line_discount = 75000)
     from public.sale_items where sale_id = t.id('sale1')));
select t.ok('la oportunidad se cierra como GANADA por el valor neto (sin impuestos: 875.000) y el log dice por qué',
  (select o.status = 'won' and o.amount = 875000 and o.closed_at is not null from public.opportunities o where o.id = t.id('opp1'))
  and (select reason = 'Venta VTA-0001' and to_state = 'Ganada' and source = 'system'
         from public.state_transitions where entity_id = t.id('opp1') order by occurred_at desc, id desc limit 1));
select t.ok('se abre el seguimiento postventa: 3 tareas del responsable del cliente (entrega, satisfacción, recompra)',
  (select count(*) = 3 and bool_and(assignee_id = :S1 and status = 'open' and description like 'Seguimiento postventa de VTA-0001%')
      and bool_or(type = 'call' and due_at between now() + interval '2 days 23 hours' and now() + interval '3 days 1 hour')
      and bool_or(due_at between now() + interval '59 days' and now() + interval '61 days')
     from public.tasks where opportunity_id = t.id('opp1')));
select t.ok('el historial de la venta arranca en «confirmada» y se emite el evento en la línea de tiempo del cliente',
  (select to_state = 'confirmed' and from_state is null from public.state_transitions where entity_type = 'sale' and entity_id = t.id('sale1'))
  and (select count(*) = 1 from public.domain_events where customer_id = t.id('carlos') and type = 'sale.created'));

select t.as_user(:M);
select t.throws('la misma cotización no genera dos ventas activas', format('select public.create_sale(%L)', t.id('q1')), '23505');
select t.reset();

select t.as_user(:S1); select t.ok('S1 (dueño) ve su venta, sus líneas y su historial',
  (select count(*) from public.sales) = 1 and (select count(*) from public.sale_items) = 2
  and (select count(*) from public.state_transitions where entity_type = 'sale') = 1); select t.reset();
select t.as_user(:S2); select t.ok('S2 no ve nada de la venta', (select count(*) from public.sales) = 0 and (select count(*) from public.sale_items) = 0); select t.reset();
select t.as_user(:V);  select t.ok('un viewer no ve ventas de clientes ajenos', (select count(*) from public.sales) = 0); select t.reset();
select t.as_user(:E);  select t.ok('el sales manager ve la de su equipo', (select count(*) from public.sales) = 1); select t.reset();
select t.as_user(:M);  select t.ok('el manager la ve', (select count(*) from public.sales) = 1); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no', (select count(*) from public.sales) = 0); select t.reset();

-- ---------------------------------------------------------------------------
-- La venta es inmutable
-- ---------------------------------------------------------------------------
select t.throws('los importes de una venta no se modifican (ni siquiera con privilegios de administrador)',
  format('update public.sales set total = 1 where id = %L', t.id('sale1')), '23514');
select t.throws('ni la cotización de origen', format('update public.sales set quote_id = %L where id = %L', t.id('q1b'), t.id('sale1')), '23514');
select t.throws('el estado no se cambia fuera de sus funciones', format('update public.sales set status = ''delivered'' where id = %L', t.id('sale1')), '42501');
select t.throws('las líneas vendidas no se modifican', format('update public.sale_items set unit_price = 1 where sale_id = %L', t.id('sale1')), '42501');
select t.throws('ni se borran', format('delete from public.sale_items where sale_id = %L', t.id('sale1')), '42501');
select t.throws('ni se vacía la tabla', $$truncate public.sale_items$$, '42501');
select t.as_user(:S1);
select t.throws('un usuario no puede escribir en sales', format('update public.sales set status = ''cancelled'' where id = %L', t.id('sale1')), '42501');
select t.throws('ni insertar', format('insert into public.sales (org_id, number, customer_id, opportunity_id, quote_id, subtotal, discount_total, tax_total, total) values (%L, ''X'', %L, %L, %L, 1, 0, 0, 1)', t.id('orgA'), t.id('carlos'), t.id('opp1'), t.id('q1')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Entregar y anular
-- ---------------------------------------------------------------------------
select t.as_user(:S1); select t.throws('un vendedor no marca entregas (sales:update)', format('select public.mark_sale_delivered(%L)', t.id('sale1')), '42501'); select t.reset();
select t.as_user(:E);
select public.mark_sale_delivered(t.id('sale1'));
select t.throws('no se entrega dos veces', format('select public.mark_sale_delivered(%L)', t.id('sale1')), '23514');
select t.throws('un sales manager NO anula ventas (solo manager/admin)', format('select public.cancel_sale(%L, ''Error de digitación'')', t.id('sale1')), '42501');
select t.reset();
select t.ok('entregada', (select status = 'delivered' and delivered_at is not null from public.sales where id = t.id('sale1')));

select t.as_user(:S1);
select public.complete_task((select id from public.tasks where opportunity_id = t.id('opp1') and type = 'call'));
select t.reset();
select t.as_user(:M);
select t.throws('anular exige un motivo', format('select public.cancel_sale(%L, ''ab'')', t.id('sale1')), '23514');
select public.cancel_sale(t.id('sale1'), 'El cliente desistió y se devolvió el dinero');
select t.throws('no se anula dos veces', format('select public.cancel_sale(%L, ''otra vez'')', t.id('sale1')), '23514');
select t.reset();
select t.ok('anulada: fecha y motivo (y la foto sigue intacta)',
  (select status = 'cancelled' and cancelled_at is not null and cancel_reason like 'El cliente desistió%' and total = 1041250 from public.sales where id = t.id('sale1')));
select t.ok('el historial cuenta todo: confirmada → entregada → anulada, con el motivo',
  (select array_agg(to_state order by occurred_at, id) = array['confirmed', 'delivered', 'cancelled']
      and bool_or(reason like 'El cliente desistió%')
     from public.state_transitions where entity_type = 'sale' and entity_id = t.id('sale1')));
select t.ok('el seguimiento pendiente se cancela; lo que ya se hizo se conserva',
  (select count(*) filter (where status = 'done') = 1 and count(*) filter (where status = 'cancelled' and outcome = 'Venta anulada') = 2
     from public.tasks where opportunity_id = t.id('opp1')));

select t.as_user(:E);
select t.save('sale2', public.create_sale(t.id('q1')));
select t.reset();
select t.ok('tras anular se puede volver a vender la misma cotización (VTA-0002) sin reabrir nada',
  (select number = 'VTA-0002' and status = 'confirmed' from public.sales where id = t.id('sale2'))
  and (select count(*) = 6 from public.tasks where opportunity_id = t.id('opp1')));

-- ---------------------------------------------------------------------------
-- Casos especiales de la oportunidad
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('opp4', public.create_opportunity(t.id('carlos'), 'Se cae', 1));
select t.save('q4', public.create_quote(t.id('opp4')));
select public.add_quote_item(t.id('q4'), null, 'X', 1, 100, 0, 0);
select public.send_quote(t.id('q4'));
select public.accept_quote(t.id('q4'));
select public.move_opportunity(t.id('opp4'), (select id from public.pipeline_stages where kind = 'lost' and org_id = t.id('orgA') limit 1), 'El cliente cambió de idea');
select t.reset();
select t.as_user(:E);
select t.throws('no se registra una venta sobre una oportunidad PERDIDA', format('select public.create_sale(%L)', t.id('q4')), '23514');
select t.reset();

-- Cliente sin propietario y «no contactar»
select t.as_service();
select t.save('sindueno', (public.ingest_lead(t.id('orgA'), '{"name":"Sin Dueño","identifiers":[{"type":"phone","value":"+573003334455"}]}'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_user(:M);
select t.ok('el manager marca «no contactar»', t.affected($q$update public.customers set do_not_contact = true, dnc_reason = 'Pidió baja' where id = {sindueno}$q$) = 1);
select t.save('opp_un', public.create_opportunity(t.id('sindueno'), 'Sin dueño', 1));
select t.save('q_un', public.create_quote(t.id('opp_un')));
select public.add_quote_item(t.id('q_un'), null, 'Y', 1, 1000, 0, 19);
select public.send_quote(t.id('q_un'));
select public.accept_quote(t.id('q_un'));
select t.save('sale_un', public.create_sale(t.id('q_un')));
select t.reset();
select t.ok('cliente sin dueño: el seguimiento queda SIN asignar (lo reparte un manager) y avisa que pidió no ser contactado',
  (select count(*) = 3 and bool_and(assignee_id is null and description like '%ATENCIÓN: el cliente pidió no ser contactado%')
     from public.tasks where opportunity_id = t.id('opp_un')));
select t.as_user(:S1); select t.ok('un vendedor no ve esa venta', (select count(*) from public.sales where id = t.id('sale_un')) = 0); select t.reset();

-- ---------------------------------------------------------------------------
-- Casos de postventa
-- ---------------------------------------------------------------------------
select t.as_user(:M);
select t.save('ester', (public.create_customer(t.id('orgA'), 'person', 'Ester Gil', '[{"type":"phone","value":"+573004445566"}]'::jsonb) ->> 'customer_id')::uuid);
select t.ok('el manager le asigna a Ester a servicio al cliente', t.affected($q$update public.customers set owner_id = {CS} where id = {ester}$q$) = 1);
select t.reset();

select t.as_user(:CS);
select t.save('case1', public.open_case(t.id('orgA'), t.id('ester'), 'No llegó el pedido', 'support', 'Pasaron 5 días', 'high'));
select t.throws('servicio al cliente no abre casos de clientes que no le corresponden',
  format('select public.open_case(%L, %L, ''X'')', t.id('orgA'), t.id('carlos')), '42501');
select t.reset();
select t.ok('el caso nace abierto, numerado, y asignado a quien lo abre',
  (select number = 'CAS-0001' and status = 'open' and assignee_id = :CS and priority = 'high' and resolution is null from public.cases where id = t.id('case1')));

select t.as_user(:S1);
select t.save('case2', public.open_case(t.id('orgA'), t.id('carlos'), 'Falla del producto', 'warranty', null, 'normal', t.id('sale2')));
select t.throws('la venta debe ser del mismo cliente', format('select public.open_case(%L, %L, ''X'', ''support'', null, ''normal'', %L)', t.id('orgA'), t.id('carlos'), t.id('sale_un')), '42501');
select t.throws('el vendedor no cambia estados de casos (cases:update)', format('select public.set_case_status(%L, ''in_progress'')', t.id('case2')), '42501');
select t.throws('el título no puede estar vacío', format('select public.open_case(%L, %L, ''  '')', t.id('orgA'), t.id('carlos')), '22023');
select t.reset();
select t.ok('CAS-0002 quedó ligado a la venta', (select number = 'CAS-0002' and sale_id = t.id('sale2') from public.cases where id = t.id('case2')));

select t.as_user(:CS);
select public.set_case_status(t.id('case1'), 'in_progress');
select t.throws('resolver exige escribir la solución', format('select public.set_case_status(%L, ''resolved'')', t.id('case1')), '23514');
select t.throws('no se salta de abierto a cerrado', format('select public.set_case_status(%L, ''closed'')', t.id('case1')), '23514');
select public.set_case_status(t.id('case1'), 'resolved', 'Se reenvió el pedido por mensajería express');
select t.ok('resuelto: queda la solución y la fecha',
  (select status = 'resolved' and resolution like 'Se reenvió%' and resolved_at is not null from public.cases where id = t.id('case1')));
select public.set_case_status(t.id('case1'), 'closed');
select t.throws('un caso cerrado solo lo reabre un manager', format('select public.set_case_status(%L, ''open'')', t.id('case1')), '42501');
select t.reset();
select t.as_user(:M);
select public.set_case_status(t.id('case1'), 'open', 'El cliente reporta que sigue sin llegar');
select t.reset();
select t.ok('el manager lo reabre y se limpia la solución', (select status = 'open' and resolution is null and resolved_at is null from public.cases where id = t.id('case1')));
select t.ok('el historial del caso: abierto → en curso → resuelto → cerrado → abierto',
  (select array_agg(to_state order by occurred_at, id) = array['open', 'in_progress', 'resolved', 'closed', 'open']
     from public.state_transitions where entity_type = 'case' and entity_id = t.id('case1')));

select t.as_user(:CS);
select t.throws('el estado no se escribe directamente', format('update public.cases set status = ''closed'' where id = %L', t.id('case1')), '42501');
select t.throws('un caso no se reasigna a otra persona sin ser manager', format('update public.cases set assignee_id = %L where id = %L', :S2, t.id('case1')), '42501');
select t.ok('pero sí edita título y prioridad', t.affected($q$update public.cases set priority = 'urgent' where id = {case1}$q$) = 1);
select t.reset();
select t.as_user(:M);
select t.ok('el manager reasigna el caso', t.affected($q$update public.cases set assignee_id = {S2} where id = {case1}$q$) = 1);
select t.throws('a alguien que no es miembro', format('update public.cases set assignee_id = %L where id = %L', :B, t.id('case1')), '23514');
select t.reset();

select t.as_user(:S2); select t.ok('S2 ahora ve el caso que le asignaron', (select count(*) from public.cases) = 1); select t.reset();
select t.as_user(:CS); select t.ok('servicio al cliente ya no lo ve (alcance propio)', (select count(*) from public.cases) = 0); select t.reset();
select t.as_user(:E);  select t.ok('el sales manager ve los casos de su equipo (CAS-0002)', (select count(*) from public.cases where id = t.id('case2')) = 1); select t.reset();
select t.as_user(:V);  select t.ok('un viewer no ve casos', (select count(*) from public.cases) = 0); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no', (select count(*) from public.cases) = 0); select t.reset();
select t.ok('los casos y las ventas aparecen en la línea de tiempo del cliente',
  (select count(distinct type) filter (where type in ('sale.created', 'sale.delivered', 'sale.cancelled', 'case.opened')) = 4
     from public.domain_events where customer_id = t.id('carlos')));

-- ---------------------------------------------------------------------------
-- Estructura y limpieza
-- ---------------------------------------------------------------------------
select t.ok('todas las tablas de public tienen RLS',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('las funciones internas no son ejecutables por authenticated',
  not has_function_privilege('authenticated', 'app.sale_transition(uuid, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.sales_prepare()', 'EXECUTE'));
delete from public.organizations where id = t.id('orgA');
select t.ok('eliminar la organización elimina ventas, líneas y casos sin violar la inmutabilidad',
  (select count(*) from public.sales where org_id = t.id('orgA')) = 0 and (select count(*) from public.sale_items where org_id = t.id('orgA')) = 0
  and (select count(*) from public.cases where org_id = t.id('orgA')) = 0);

rollback;
\echo ✔ VENTAS Y POSTVENTA: TODAS LAS PRUEBAS PASARON
