-- Pruebas de catálogo y cotizaciones: dinero, inmutabilidad, aprobación de descuentos, versiones, visibilidad.
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

-- Clientes y oportunidades
select t.as_user(:S1);
select t.save('carlos', (public.create_customer(t.id('orgA'), 'person', 'Carlos Rodríguez', '[{"type":"phone","value":"+573001112233"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('opp1', public.create_opportunity(t.id('carlos'), 'Plan A', 1000000));
select t.save('opp3', public.create_opportunity(t.id('carlos'), 'Plan cerrado', 1));
select t.reset();
select t.as_user(:S2);
select t.save('diana', (public.create_customer(t.id('orgA'), 'person', 'Diana Torres', '[{"type":"phone","value":"+573002223344"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('opp2', public.create_opportunity(t.id('diana'), 'Plan D', 1000000));
select t.reset();
select t.as_service();
select t.save('sindueno', (public.ingest_lead(t.id('orgA'), '{"name":"Sin Dueño","identifiers":[{"type":"phone","value":"+573003334455"}]}'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_user(:M);
select t.save('opp_un', public.create_opportunity(t.id('sindueno'), 'Sin dueño', 10));
select t.reset();
select t.save('st_won', (select s.id from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id where p.org_id = t.id('orgA') and p.is_default and s.kind = 'won'));
select t.as_user(:S1); select public.move_opportunity(t.id('opp3'), t.id('st_won')); select t.reset();

-- ---------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------
select t.as_user(:A);
insert into public.products (org_id, kind, sku, name, unit, unit_price, tax_rate) values
  (t.id('orgA'), 'service', 'SRV-1', 'Consultoría', 'hora', 100000, 19),
  (t.id('orgA'), 'product', 'SIL-1', 'Silla ergonómica', 'unidad', 250000, 19);
select t.save('p1', (select id from public.products where sku = 'SRV-1'));
select t.save('p2', (select id from public.products where sku = 'SIL-1'));
select t.throws('el SKU es único sin importar mayúsculas',
  format('insert into public.products (org_id, sku, name) values (%L, ''sil-1'', ''Otra'')', t.id('orgA')), '23505');
select t.throws('precio negativo', format('insert into public.products (org_id, name, unit_price) values (%L, ''X'', -1)', t.id('orgA')), '23514');
select t.throws('IVA fuera de rango', format('insert into public.products (org_id, name, tax_rate) values (%L, ''X'', 101)', t.id('orgA')), '23514');
select t.throws('el tipo no se cambia (privilegio de columna)', format('update public.products set kind = ''service'' where id = %L', t.id('p2')), '42501');
select t.throws('DELETE directo denegado', format('delete from public.products where id = %L', t.id('p2')), '42501');
select t.reset();

select t.as_user(:S1); select t.ok('un vendedor ve el catálogo', (select count(*) from public.products) = 2); select t.reset();
select t.as_user(:V);  select t.ok('un viewer también', (select count(*) from public.products) = 2); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no', (select count(*) from public.products) = 0); select t.reset();
select t.as_user(:S1);
select t.throws('un vendedor no crea productos', format('insert into public.products (org_id, name) values (%L, ''Hack'')', t.id('orgA')), '42501');
select t.ok('ni los edita (RLS: 0 filas)', t.affected($q$update public.products set unit_price = 1 where id = {p2}$q$) = 0);
select t.reset();
select t.ok('el precio no cambió', (select unit_price = 250000 from public.products where id = t.id('p2')));

-- ---------------------------------------------------------------------------
-- Crear cotización
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('q1', public.create_quote(t.id('opp1'), null, 'Cotización de prueba'));
select t.reset();
select t.ok('nace en borrador, v1, numerada, con la moneda y el dueño de la oportunidad',
  (select number = 'COT-0001' and version = 1 and status = 'draft' and currency = 'COP' and owner_id = :S1 and team_id = :T1
      and valid_until = current_date + 15 and customer_id = t.id('carlos') and total = 0
     from public.quotes where id = t.id('q1')));
select t.as_user(:S1);
select t.throws('no sobre una oportunidad ajena', format('select public.create_quote(%L)', t.id('opp2')), '42501');
select t.throws('NI sobre una oportunidad SIN propietario (regresión: NULL en el acceso)', format('select public.create_quote(%L)', t.id('opp_un')), '42501');
select t.throws('no sobre una oportunidad cerrada', format('select public.create_quote(%L)', t.id('opp3')), '23514');
select t.throws('la vigencia no puede estar en el pasado', format('select public.create_quote(%L, current_date - 1)', t.id('opp1')), '22023');
select t.reset();
select t.as_user(:V);
select t.throws('un viewer no puede crear cotizaciones', format('select public.create_quote(%L)', t.id('opp1')), '42501');
select t.reset();

-- ---------------------------------------------------------------------------
-- Líneas y dinero
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('i1', public.add_quote_item(t.id('q1'), t.id('p1'), null, 2));
select t.save('i2', public.add_quote_item(t.id('q1'), t.id('p2'), null, 3, null, 10));
select t.reset();
select t.ok('línea 1 (2 × 100.000, IVA 19 %): bruto 200.000, IVA 38.000, total 238.000',
  (select line_gross = 200000 and line_discount = 0 and line_tax = 38000 and line_total = 238000 and description = 'Consultoría' and unit = 'hora'
     from public.quote_items where id = t.id('i1')));
select t.ok('línea 2 (3 × 250.000, desc. 10 %): bruto 750.000, desc. 75.000, IVA 128.250, total 803.250',
  (select line_gross = 750000 and line_discount = 75000 and line_tax = 128250 and line_total = 803250 and tax_rate = 19
     from public.quote_items where id = t.id('i2')));
select t.ok('los totales de la cotización salen de las líneas (nadie los escribe)',
  (select subtotal = 950000 and discount_total = 75000 and tax_total = 166250 and total = 1041250 and max_discount_pct = 10
     from public.quotes where id = t.id('q1')));

select t.as_user(:S1);
select t.save('i3', public.add_quote_item(t.id('q1'), null, 'Línea libre', 0.333, 100.10, 15.5, 19));
select t.reset();
select t.ok('el redondeo es por línea y a 2 decimales (33,33 − 5,17 + 5,35 = 33,51)',
  (select line_gross = 33.33 and line_discount = 5.17 and line_tax = 5.35 and line_total = 33.51 from public.quote_items where id = t.id('i3')));
select t.as_user(:S1); select public.remove_quote_item(t.id('i3')); select t.reset();
select t.ok('quitar la línea devuelve los totales anteriores', (select total = 1041250 from public.quotes where id = t.id('q1')));

-- Foto del producto: cambiar el catálogo NO altera lo ya cotizado
select t.as_user(:A); update public.products set unit_price = 999999, name = 'Consultoría PREMIUM' where id = t.id('p1'); select t.reset();
select t.ok('la línea conserva el precio y el nombre del momento de cotizar',
  (select unit_price = 100000 and description = 'Consultoría' from public.quote_items where id = t.id('i1')));

select t.as_user(:S1);
select t.throws('cantidad cero', format('select public.add_quote_item(%L, null, ''X'', 0, 10)', t.id('q1')), '23514');
select t.throws('descuento mayor a 100 %', format('select public.add_quote_item(%L, null, ''X'', 1, 10, 101)', t.id('q1')), '23514');
select t.throws('línea libre sin descripción o sin precio', format('select public.add_quote_item(%L, null, null, 1, null)', t.id('q1')), '22023');
select t.throws('producto de otra organización o inexistente', format('select public.add_quote_item(%L, %L)', t.id('q1'), gen_random_uuid()), '22023');
select t.reset();
select t.as_user(:A); update public.products set active = false where id = t.id('p2'); select t.reset();
select t.as_user(:S1);
select t.throws('un producto inactivo no se puede cotizar', format('select public.add_quote_item(%L, %L)', t.id('q1'), t.id('p2')), '22023');
select t.throws('los totales no se escriben directamente (privilegio de columna)', format('update public.quotes set total = 1 where id = %L', t.id('q1')), '42501');
select t.throws('las líneas no se insertan directamente', format('insert into public.quote_items (org_id, quote_id, description, quantity, unit_price) values (%L, %L, ''X'', 1, 1)', t.id('orgA'), t.id('q1')), '42501');
select t.throws('ni se modifican directamente', format('update public.quote_items set unit_price = 1 where id = %L', t.id('i1')), '42501');
select t.reset();

select t.as_user(:S2);
select t.ok('S2 no ve la cotización ni sus líneas', (select count(*) from public.quotes) = 0 and (select count(*) from public.quote_items) = 0);
select t.throws('ni puede agregarle líneas', format('select public.add_quote_item(%L, null, ''X'', 1, 10)', t.id('q1')), '42501');
select t.reset();
select t.as_user(:M);  select t.ok('el manager ve cotización y líneas', (select count(*) from public.quotes) = 1 and (select count(*) from public.quote_items) = 2); select t.reset();
select t.as_user(:E);  select t.ok('el sales manager ve las de su equipo', (select count(*) from public.quotes) = 1); select t.reset();
select t.as_user(:V);  select t.ok('un viewer no ve cotizaciones ajenas', (select count(*) from public.quotes) = 0); select t.reset();
select t.as_user(:B);  select t.ok('otra organización no ve nada', (select count(*) from public.quotes) = 0); select t.reset();

-- ---------------------------------------------------------------------------
-- Enviar: reglas y aprobación de descuentos
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('q_empty', public.create_quote(t.id('opp1')));
select t.throws('no se envía una cotización vacía', format('select public.send_quote(%L)', t.id('q_empty')), '23514');
select public.send_quote(t.id('q1'));
select t.reset();
select t.ok('descuento de 10 % con límite de 10 %: el propio vendedor puede enviar (límite inclusivo)',
  (select status = 'sent' and sent_at is not null from public.quotes where id = t.id('q1')));

select t.as_user(:S2);
select t.save('q2', public.create_quote(t.id('opp2')));
select public.add_quote_item(t.id('q2'), null, 'Servicio con descuento alto', 1, 1000000, 25, 19);
select t.throws('un descuento de 25 % (> límite) NO lo puede enviar el vendedor', format('select public.send_quote(%L)', t.id('q2')), '42501');
select t.reset();
select t.ok('...y sigue en borrador', (select status = 'draft' from public.quotes where id = t.id('q2')));
select t.as_user(:M);
select public.send_quote(t.id('q2'));
select t.reset();
select t.ok('el manager aprueba enviándola', (select status = 'sent' from public.quotes where id = t.id('q2')));

-- El límite es configurable por organización
select t.as_user(:S2);
select t.save('q2b', public.create_quote(t.id('opp2')));
select public.add_quote_item(t.id('q2b'), null, 'Otro con 25 %', 1, 1000, 25, 0);
select t.reset();
update public.organizations set settings = settings || '{"quote_discount_limit_pct": 30}' where id = t.id('orgA');
select t.as_user(:S2); select public.send_quote(t.id('q2b')); select t.reset();
select t.ok('con el límite en 30 %, el vendedor puede enviar 25 %', (select status = 'sent' from public.quotes where id = t.id('q2b')));
update public.organizations set settings = settings - 'quote_discount_limit_pct' where id = t.id('orgA');

-- Inmutabilidad
select t.as_user(:S1);
select t.throws('una cotización enviada no admite nuevas líneas', format('select public.add_quote_item(%L, null, ''X'', 1, 10)', t.id('q1')), '23514');
select t.throws('ni cambiar líneas', format('select public.update_quote_item(%L, 1, 1, 0)', t.id('i1')), '23514');
select t.throws('ni quitarlas', format('select public.remove_quote_item(%L)', t.id('i1')), '23514');
select t.throws('ni cambiar la vigencia o las notas', format('update public.quotes set valid_until = current_date + 90 where id = %L', t.id('q1')), '23514');
select t.throws('no se envía dos veces', format('select public.send_quote(%L)', t.id('q1')), '23514');
select t.reset();
select t.throws('ni siquiera un superusuario borra líneas de una cotización enviada', format('delete from public.quote_items where id = %L', t.id('i1')), '23514');

-- ---------------------------------------------------------------------------
-- Vencimiento, aceptar, rechazar
-- ---------------------------------------------------------------------------
-- (simula el paso del tiempo: la app nunca edita la vigencia de una cotización enviada)
set local app.quote_transition = 'on';
update public.quotes set valid_until = current_date - 1 where id = t.id('q2b');
set local app.quote_transition = 'off';
select t.as_user(:S2);
select t.throws('una cotización vencida no se puede aceptar', format('select public.accept_quote(%L)', t.id('q2b')), '23514');
select t.reset();
set local app.quote_transition = 'on';
update public.quotes set valid_until = current_date + 5 where id = t.id('q2b');
set local app.quote_transition = 'off';

select t.as_user(:S2);
select t.throws('S2 no puede aceptar la cotización de S1', format('select public.accept_quote(%L)', t.id('q1')), '42501');
select t.throws('un borrador no se acepta', format('select public.accept_quote(%L)', t.id('q_empty')), '42501');
select t.reset();
select t.as_user(:S1);
select t.throws('un borrador no se acepta', format('select public.accept_quote(%L)', t.id('q_empty')), '23514');
select public.accept_quote(t.id('q1'));
select t.reset();
select t.ok('aceptada: fecha y quién decidió', (select status = 'accepted' and decided_at is not null and decided_by = :S1 from public.quotes where id = t.id('q1')));
select t.ok('la oportunidad NO se cierra sola (la venta la registra quien corresponda)', (select status = 'open' from public.opportunities where id = t.id('opp1')));

select t.as_user(:S1);
select t.save('q1b', public.create_quote(t.id('opp1')));
select public.add_quote_item(t.id('q1b'), null, 'Alternativa', 1, 500, 0, 0);
select public.send_quote(t.id('q1b'));
select t.throws('solo puede haber UNA cotización aceptada por oportunidad', format('select public.accept_quote(%L)', t.id('q1b')), '23505');
select public.reject_quote(t.id('q1b'), 'El cliente prefiere la otra');
select t.reset();
select t.ok('rechazada con motivo en el historial',
  (select reason = 'El cliente prefiere la otra' and from_state = 'sent' and to_state = 'rejected'
     from public.state_transitions where entity_type = 'quote' and entity_id = t.id('q1b') order by occurred_at desc, id desc limit 1));

-- ---------------------------------------------------------------------------
-- Versiones
-- ---------------------------------------------------------------------------
select t.as_user(:S1);
select t.save('q1c', public.revise_quote(t.id('q1b')));
select t.throws('una aceptada no se revisa', format('select public.revise_quote(%L)', t.id('q1')), '23514');
select t.throws('un borrador tampoco (se edita directamente)', format('select public.revise_quote(%L)', t.id('q1c')), '23514');
select t.throws('no se revisa dos veces la misma versión', format('select public.revise_quote(%L)', t.id('q1b')), '23514');
select t.reset();
select t.ok('la nueva versión conserva número, sube versión, copia las líneas y queda en borrador',
  (select number = 'COT-0005' and number = (select number from public.quotes where id = t.id('q1b')) and version = 2 and status = 'draft' and total = 500 and parent_quote_id = t.id('q1b')
     from public.quotes where id = t.id('q1c')));
select t.ok('la anterior queda «reemplazada»', (select status = 'superseded' from public.quotes where id = t.id('q1b')));
select t.ok('el historial de la versión anterior: borrador → enviada → rechazada → reemplazada',
  (select array_agg(to_state order by occurred_at, id) = array['draft', 'sent', 'rejected', 'superseded']
     from public.state_transitions where entity_type = 'quote' and entity_id = t.id('q1b')));
select t.as_user(:S1);
select public.add_quote_item(t.id('q1c'), null, 'Extra', 1, 100, 0, 0);
select t.reset();
select t.ok('la versión nueva sí se edita', (select total = 600 from public.quotes where id = t.id('q1c')));

-- ---------------------------------------------------------------------------
-- Numeración
-- ---------------------------------------------------------------------------
select t.ok('la numeración es correlativa por organización: COT-0001 a COT-0005, sin repetidos ni huecos',
  (select array_agg(number order by number) = array['COT-0001', 'COT-0002', 'COT-0003', 'COT-0004', 'COT-0005']
     from (select distinct number from public.quotes where org_id = t.id('orgA')) x));
select t.as_user(:B);
select t.save('custB', (public.create_customer(t.id('orgB'), 'person', 'Cliente Beta', '[{"type":"phone","value":"+573009990000"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('oppB', public.create_opportunity(t.id('custB'), 'Beta opp'));
select t.save('qB', public.create_quote(t.id('oppB')));
select t.reset();
select t.ok('cada organización numera por separado: la primera de B es COT-0001 aunque A ya va en 5',
  (select number = 'COT-0001' from public.quotes where id = t.id('qB')));
savepoint sp;
select app.next_number(t.id('orgA'), 'prueba');
rollback to sp;
select t.ok('si la transacción se revierte NO se pierde el número (sin huecos)', app.next_number(t.id('orgA'), 'prueba') = 1);

-- ---------------------------------------------------------------------------
-- Seguimiento del cliente, fusión y línea de tiempo
-- ---------------------------------------------------------------------------
select t.as_user(:M);
select t.ok('el manager reasigna a Carlos a S2', t.affected($q$update public.customers set owner_id = {S2} where id = {carlos}$q$) = 1);
select t.reset();
select t.ok('el borrador abierto sigue al cliente; la aceptada conserva su propietario',
  (select owner_id = :S2 from public.quotes where id = t.id('q1c')) and (select owner_id = :S1 from public.quotes where id = t.id('q1')));
select t.as_user(:M);
select t.ok('el manager devuelve a Carlos a S1', t.affected($q$update public.customers set owner_id = {S1} where id = {carlos}$q$) = 1);
select public.merge_customers(t.id('carlos'), t.id('diana'));
select t.reset();
select t.ok('la fusión mueve las cotizaciones del cliente absorbido',
  (select customer_id = t.id('carlos') from public.quotes where id = t.id('q2')));
select t.as_user(:S1);
select t.ok('la línea de tiempo del cliente incluye las cotizaciones',
  (select count(distinct type) filter (where type in ('quote.created', 'quote.sent', 'quote.accepted', 'quote.rejected')) = 4
     from public.customer_timeline(t.id('carlos'), 200)));
select t.reset();

-- ---------------------------------------------------------------------------
-- Estructura y limpieza
-- ---------------------------------------------------------------------------
select t.ok('todas las tablas de public tienen RLS',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);
select t.ok('las funciones internas no son ejecutables por authenticated',
  not has_function_privilege('authenticated', 'app.next_number(uuid, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.recalc_quote(uuid)', 'EXECUTE'));
delete from public.organizations where id = t.id('orgA');
select t.ok('eliminar la organización elimina cotizaciones y líneas (aunque estén enviadas)',
  (select count(*) from public.quotes where org_id = t.id('orgA')) = 0
  and (select count(*) from public.quote_items where org_id = t.id('orgA')) = 0);
select t.ok('...y no toca los datos de otra organización', (select count(*) from public.quotes where org_id = t.id('orgB')) = 1);

rollback;
\echo ✔ COTIZACIONES: TODAS LAS PRUEBAS PASARON
