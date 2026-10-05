-- Pruebas de 0036: métricas del widget — registro de cierres, la atribución de cada lead del widget (escribió por
-- WhatsApp, primera respuesta humana, resolución, oportunidad, venta), y que cada rol vea solo lo que ya veía.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A   '''aaaaaaaa-e666-0000-0000-00000000000a'''
\set B   '''bbbbbbbb-e666-0000-0000-00000000000b'''
\set S1  '''51000000-e666-0000-0000-000000000001'''
\set S2  '''52000000-e666-0000-0000-000000000002'''
\set E   '''e0000000-e666-0000-0000-00000000000e'''
\set CS  '''c5000000-e666-0000-0000-0000000000c5'''
\set T1  '''71000000-e666-0000-0000-000000000001'''
\set T2  '''72000000-e666-0000-0000-000000000002'''
\set PID '''9600000001'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@wm.test'), (:B, 'b@wm.test'), (:S1, 's1@wm.test'), (:S2, 's2@wm.test'), (:E, 'e@wm.test'), (:CS, 'cs@wm.test');
select t.as_user(:A); select t.save('org', public.create_organization('Métricas Widget', 'metricas-widget')); select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Otra', 'metricas-otra')); select t.reset();
insert into public.teams (id, org_id, name, region) values (:T1, t.id('org'), 'Bogotá', 'Bogotá'), (:T2, t.id('org'), 'Medellín', 'Medellín');
insert into public.memberships (org_id, user_id, role_id, team_id)
  select t.id('org'), u.uid, r.id, u.team
    from (values (:S1::uuid, 'sales_agent', :T1::uuid), (:S2::uuid, 'sales_agent', :T2::uuid), (:E::uuid, 'sales_manager', :T1::uuid), (:CS::uuid, 'customer_service', null::uuid)) u(uid, rk, team)
    join public.roles r on r.key = u.rk and r.org_id is null;

select t.as_user(:A); select t.save('wa', public.create_channel(t.id('org'), 'Ventas', :PID, '+57 300 600 0001', 'token-wa-abcdefghijklmnop')); select t.reset();
select t.as_user(:A);
insert into public.whatsapp_widgets (org_id, channel_id, name, allowed_domains, region) values (t.id('org'), t.id('wa'), 'Web Bogotá', array['arkos.com.co'], 'Bogotá');
select t.reset();
select t.save('w', (select id from public.whatsapp_widgets where name = 'Web Bogotá'));

-- Un visitante usa el widget (como lo hace la ruta pública: service_role). Devuelve el id del lead creado.
create function t.widget(p_name text, p_phone text, p_page text, p_campaign text) returns uuid language plpgsql as $$
begin
  perform t.as_service();
  perform public.start_widget_conversation(t.id('w'), 'arkos.com.co', p_name, p_phone, null, 'Hola', p_page, null, 'https://arkos.com.co/p/silla',
                                           'google', 'cpc', p_campaign, null);
  perform t.reset();
  return (select id from public.leads where contact_phone = p_phone and source = 'widget_web' order by received_at desc, created_at desc limit 1);
end $$;
-- El mensaje que el visitante realmente envía por WhatsApp (webhook de Meta).
create function t.inbound(p_phone text, p_wamid text, p_at timestamptz) returns void language plpgsql as $$
begin
  perform t.as_service();
  perform public.ingest_whatsapp_message(current_setting('t.pid'), ltrim(p_phone, '+'), 'Visitante', p_wamid, 'text', 'Hola, vengo de la web', p_at);
  perform t.reset();
end $$;
select set_config('t.pid', :PID, true);

-- ============================================================ 1. registro de cierres
-- Pedro: contacto NUEVO, recorrido completo. El lead se recibió hace 2 h; escribió por WhatsApp 10 min después.
select t.save('L_pedro', t.widget('Pedro Pérez', '+573006000001', 'https://arkos.com.co/sillas?utm_source=google', 'verano'));
update public.leads set received_at = now() - interval '2 hours' where id = t.id('L_pedro');
select t.inbound('+573006000001', 'wamid.P1', now() - interval '110 minutes');
select t.save('pedro', (select customer_id from public.leads where id = t.id('L_pedro')));
select t.save('conv_p', (select id from public.conversations where customer_id = t.id('pedro')));
update public.customers set owner_id = :S1 where id = t.id('pedro');

select t.ok('una conversación recién abierta no tiene cierres registrados', (select count(*) = 0 from public.conversation_closures where conversation_id = t.id('conv_p')));

-- Respuesta AUTOMÁTICA (sin persona): no cuenta como primera respuesta.
insert into public.messages (org_id, channel_id, conversation_id, direction, kind, body, status, sent_by, occurred_at)
values (t.id('org'), t.id('wa'), t.id('conv_p'), 'outbound', 'text', 'Mensaje automático', 'sent', null, now() - interval '109 minutes');
-- Respuesta HUMANA de S1 (el asesor dueño)
select t.as_user(:S1); select public.queue_message(t.id('conv_p'), 'Hola Pedro, con gusto te ayudo'); select t.reset();
select t.as_user(:S1); select public.set_conversation_status(t.id('conv_p'), 'closed'); select t.reset();

select t.ok('cerrar una conversación deja registrado cuándo y quién',
  (select count(*) = 1 and bool_and(closed_by = :S1) from public.conversation_closures where conversation_id = t.id('conv_p')));
select t.as_user(:S1); select public.set_conversation_status(t.id('conv_p'), 'closed'); select t.reset();
select t.ok('«cerrar» algo ya cerrado no registra un segundo cierre', (select count(*) = 1 from public.conversation_closures where conversation_id = t.id('conv_p')));
select t.as_user(:S1); select public.set_conversation_status(t.id('conv_p'), 'open'); select public.set_conversation_status(t.id('conv_p'), 'closed'); select t.reset();
select t.ok('reabrir y volver a cerrar registra el segundo cierre (el historial no se pierde)', (select count(*) = 2 from public.conversation_closures where conversation_id = t.id('conv_p')));
select t.as_user(:A);
select t.throws('nadie lee el registro de cierres directamente (solo a través de las métricas)', 'select count(*) from public.conversation_closures', '42501');
select t.reset();

-- Pedro → oportunidad (como el botón del Inbox: para el CLIENTE, no para el lead) → cotización → venta
select t.as_user(:S1); select t.save('opp_p', public.create_opportunity(t.id('pedro'), 'Sillas para oficina', 0)); select t.save('q_p', public.create_quote(t.id('opp_p')));
select public.add_quote_item(t.id('q_p'), null, 'Silla', 2, 500000, 0, 0); select public.send_quote(t.id('q_p')); select public.accept_quote(t.id('q_p')); select t.reset();
select t.as_user(:A); select t.save('sale_p', public.create_sale(t.id('q_p'))); select t.reset();

-- ============================================================ 2. otros casos de atribución
-- Lucía: llenó el formulario pero NUNCA escribió por WhatsApp (abandonó en la redirección).
select t.save('L_lucia', t.widget('Lucía Abandono', '+573006000002', 'https://arkos.com.co/mesas', 'otoño'));
update public.customers set owner_id = :S2 where id = (select customer_id from public.leads where id = t.id('L_lucia'));

-- Tardío: escribió por WhatsApp, pero 30 h después del formulario (fuera de la ventana de 24 h).
select t.save('L_tarde', t.widget('Tardío Ruiz', '+573006000003', 'https://arkos.com.co/sillas', 'verano'));
update public.leads set received_at = now() - interval '40 hours' where id = t.id('L_tarde');
select t.inbound('+573006000003', 'wamid.T1', now() - interval '10 hours');

-- Ana: ya era cliente (recurrente). Tenía una oportunidad de ANTES del formulario: no se le atribuye al widget.
select t.as_user(:A); select t.save('ana', (public.create_customer(t.id('org'), 'person', 'Ana Antigua', '[{"type":"phone","value":"+573006000004"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('opp_vieja', public.create_opportunity(t.id('ana'), 'Algo de antes', 0)); select t.reset();
update public.opportunities set created_at = now() - interval '5 days' where id = t.id('opp_vieja');
select t.save('L_ana', t.widget('Ana Antigua', '+573006000004', 'https://arkos.com.co/sillas', 'verano'));

-- Mario: oportunidad y venta, pero la venta se ANULÓ: la oportunidad cuenta, la venta no.
select t.save('L_mario', t.widget('Mario Anulado', '+573006000005', 'https://arkos.com.co/mesas', 'otoño'));
select t.save('mario', (select customer_id from public.leads where id = t.id('L_mario')));
update public.customers set owner_id = :S1 where id = t.id('mario');
select t.as_user(:S1); select t.save('opp_m', public.create_opportunity(t.id('mario'), 'Mesa', 0)); select t.save('q_m', public.create_quote(t.id('opp_m')));
select public.add_quote_item(t.id('q_m'), null, 'Mesa', 1, 300000, 0, 0); select public.send_quote(t.id('q_m')); select public.accept_quote(t.id('q_m')); select t.reset();
select t.as_user(:A); select t.save('sale_m', public.create_sale(t.id('q_m'))); select public.cancel_sale(t.id('sale_m'), 'El cliente desistió'); select t.reset();

-- Pedro vuelve por el widget DESPUÉS (lead 2, recurrente). Una oportunidad nueva creada después de ese segundo
-- lead es del segundo, no del primero (no se cuenta dos veces).
select t.save('L_pedro2', t.widget('Pedro Pérez', '+573006000001', 'https://arkos.com.co/escritorios', 'invierno'));
update public.leads set received_at = now() + interval '1 hour' where id = t.id('L_pedro2');
select t.as_user(:S1); select t.save('opp_p2', public.create_opportunity(t.id('pedro'), 'Escritorio', 0)); select t.reset();
update public.opportunities set created_at = now() + interval '2 hours' where id = t.id('opp_p2');

-- ============================================================ 3. la función de métricas, como admin
select t.as_user(:A);
create temp table f on commit drop as select * from public.widget_lead_facts(t.id('org'), now() - interval '3 days', now() + interval '1 day');
select t.reset();

select t.ok('trae solo los leads del widget del período (6), no los de WhatsApp directo ni los de otras fuentes',
  (select count(*) = 6 from f));
select t.ok('Pedro: contacto nuevo, con toda la atribución del widget',
  (select is_new and widget_id = t.id('w') and widget_name = 'Web Bogotá' and region = 'Bogotá' and utm_campaign = 'verano'
          and page_url = 'https://arkos.com.co/sillas?utm_source=google' and product_url = 'https://arkos.com.co/p/silla' and owner_id = :S1 and team_id = :T1
     from f where lead_id = t.id('L_pedro')));
select t.ok('Pedro: escribió por WhatsApp a los 10 min del formulario',
  (select first_inbound_at = now() - interval '110 minutes' from f where lead_id = t.id('L_pedro')));
select t.ok('Pedro: la primera respuesta es la HUMANA (la automática no cuenta)',
  (select first_response_at > now() - interval '1 minute' from f where lead_id = t.id('L_pedro')));
select t.ok('Pedro: resolución = el PRIMER cierre después de que escribió',
  (select closed_at = (select min(closed_at) from public.conversation_closures where conversation_id = t.id('conv_p')) from f where lead_id = t.id('L_pedro')));
select t.ok('Pedro: la oportunidad del Inbox (creada para el cliente) se atribuye a su lead del widget',
  (select opportunity_id = t.id('opp_p') from f where lead_id = t.id('L_pedro')));
select t.ok('Pedro: y la venta, con su total', (select sale_id = t.id('sale_p') and sale_total = 1000000 from f where lead_id = t.id('L_pedro')));

select t.ok('Lucía: llenó el formulario pero no escribió: sin conversación, sin respuesta, sin oportunidad',
  (select first_inbound_at is null and first_response_at is null and closed_at is null and opportunity_id is null from f where lead_id = t.id('L_lucia')));
select t.ok('Tardío: un mensaje 30 h después no se cuenta como venido del widget', (select first_inbound_at is null from f where lead_id = t.id('L_tarde')));
select t.ok('Ana: recurrente (ya era cliente)', (select not is_new from f where lead_id = t.id('L_ana')));
select t.ok('Ana: una oportunidad creada ANTES del formulario no se le atribuye al widget', (select opportunity_id is null from f where lead_id = t.id('L_ana')));
select t.ok('Mario: una venta anulada no cuenta (la oportunidad sí)', (select opportunity_id = t.id('opp_m') and sale_id is null from f where lead_id = t.id('L_mario')));
select t.ok('Pedro (2.ª vez): recurrente, y se queda con la oportunidad creada después de SU formulario',
  (select not is_new and opportunity_id = t.id('opp_p2') from f where lead_id = t.id('L_pedro2')));
select t.ok('…y esa oportunidad NO se le cuenta también al primer lead de Pedro', (select opportunity_id = t.id('opp_p') from f where lead_id = t.id('L_pedro')));

-- ============================================================ 4. permisos: cada rol ve lo que ya veía
select t.as_user(:S1);
select t.ok('un vendedor ve solo SUS leads del widget (Pedro ×2, Mario)',
  (select count(*) = 3 and bool_and(owner_id = :S1) from public.widget_lead_facts(t.id('org'), now() - interval '3 days', now() + interval '1 day')));
select t.reset();
select t.as_user(:E);
select t.ok('un jefe de ventas ve los de SU equipo (Bogotá: los de S1)',
  (select count(*) = 3 and bool_and(team_id = :T1) from public.widget_lead_facts(t.id('org'), now() - interval '3 days', now() + interval '1 day')));
select t.reset();
select t.as_user(:CS);
select t.ok('servicio al cliente (reportes sí, leads no) no ve ningún lead — sin error',
  (select count(*) = 0 from public.widget_lead_facts(t.id('org'), now() - interval '3 days', now() + interval '1 day')));
select t.reset();
select t.as_user(:B);
select t.throws('alguien de otra organización no puede pedir las métricas de esta', format('select * from public.widget_lead_facts(%L, now() - interval ''3 days'', now())', t.id('org')), '42501');
select t.reset();
select t.as_anon();
select t.throws('anon no puede llamar la función', format('select * from public.widget_lead_facts(%L, now() - interval ''3 days'', now())', t.id('org')), '42501');
select t.reset();
select t.as_user(:A);
select t.throws('nadie puede insertar cierres a mano', format('insert into public.conversation_closures (org_id, conversation_id) values (%L, %L)', t.id('org'), t.id('conv_p')), '42501');
select t.ok('el rango de fechas se respeta', (select count(*) = 0 from public.widget_lead_facts(t.id('org'), now() - interval '30 days', now() - interval '20 days')));
select t.reset();

rollback;
\echo ✔ MÉTRICAS DEL WIDGET: TODAS LAS PRUEBAS PASARON
