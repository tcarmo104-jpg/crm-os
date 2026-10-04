-- Pruebas de 0035: reglas de distribución automática — coincidencia por canal/widget/región/horario, reparto
-- por turnos dentro del equipo, y que nunca deje caer la creación del contacto si algo no encaja.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A '''aaaaaaaa-e555-0000-0000-00000000000a'''
\set S1 '''51000000-e555-0000-0000-000000000001'''
\set S2 '''52000000-e555-0000-0000-000000000002'''
\set S3 '''53000000-e555-0000-0000-000000000003'''
\set T1 '''71000000-e555-0000-0000-000000000001'''
\set T2 '''72000000-e555-0000-0000-000000000002'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@ar.test'), (:S1, 's1@ar.test'), (:S2, 's2@ar.test'), (:S3, 's3@ar.test');
select t.as_user(:A); select t.save('org', public.create_organization('Reglas Test', 'reglas-test')); select t.reset();
insert into public.teams (id, org_id, name, region) values (:T1, t.id('org'), 'Equipo Bogotá', 'Bogotá');
insert into public.memberships (org_id, user_id, role_id, team_id) select t.id('org'), :S1::uuid, r.id, :T1 from public.roles r where r.key = 'sales_agent' and r.org_id is null;
insert into public.memberships (org_id, user_id, role_id, team_id) select t.id('org'), :S2::uuid, r.id, :T1 from public.roles r where r.key = 'sales_agent' and r.org_id is null;
-- S3: mismo equipo pero SUSPENDIDO (no debe recibir turnos)
insert into public.memberships (org_id, user_id, role_id, team_id, status) select t.id('org'), :S3::uuid, r.id, :T1, 'suspended' from public.roles r where r.key = 'sales_agent' and r.org_id is null;

select t.as_user(:A); select t.save('wa', public.create_channel(t.id('org'), 'Ventas', '9500000001', '+57 300 500 0001', 'token-wa-abcdefghijklmnop')); select t.reset();
select t.as_user(:A);
insert into public.whatsapp_widgets (org_id, channel_id, name, allowed_domains) values (t.id('org'), t.id('wa'), 'Web principal', array['arkos.com.co']);
select t.reset();
select t.save('widget', (select id from public.whatsapp_widgets where name = 'Web principal'));

-- ---- Sin ninguna regla activa: nadie asignado (igual que antes de que existiera esta función)
select t.ok('sin reglas, no asigna a nadie', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null) is null));

-- ---- Una regla por equipo: reparte por turnos entre sus integrantes activos (no al suspendido)
select t.as_user(:A);
insert into public.assignment_rules (org_id, name, team_id) values (t.id('org'), 'Todo a Bogotá', :T1);
select t.reset();
select t.save('p1', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null)));
select t.save('p2', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null)));
select t.save('p3', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null)));
select t.ok('el primer turno es uno de los dos activos', (select t.id('p1') in (:S1, :S2)));
select t.ok('el segundo turno es el OTRO (no se repite seguido)', (select t.id('p2') in (:S1, :S2) and t.id('p2') <> t.id('p1')));
select t.ok('el tercer turno vuelve a empezar (da la vuelta)', (select t.id('p3') = t.id('p1')));
select t.ok('nunca le toca al integrante suspendido', (select :S3 not in (t.id('p1'), t.id('p2'), t.id('p3'))));

-- ---- Una regla con región: solo coincide si la región del visitante coincide (sin distinguir mayúsculas)
select t.as_user(:A);
delete from public.assignment_rules where org_id = t.id('org');   -- limpio: solo va a quedar la regla de abajo
insert into public.assignment_rules (org_id, name, team_id, region, priority) values (t.id('org'), 'Solo Medellín', :T1, 'Medellín', 50);
select t.reset();
select t.ok('una región que no coincide no activa la regla (y no hay otra: no asigna)', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), 'Bogotá') is null));
select t.ok('la región SÍ coincide (sin importar mayúsculas/minúsculas)', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), 'MEDELLÍN') is not null));

-- ---- Dos reglas: gana la de menor prioridad (se evalúa primero)
select t.as_user(:A);
delete from public.assignment_rules where org_id = t.id('org');
insert into public.teams (org_id, name) values (t.id('org'), 'Equipo General');
insert into public.assignment_rules (org_id, name, team_id, priority) values (t.id('org'), 'Regla general', (select id from public.teams where name = 'Equipo General' and org_id = t.id('org')), 200);
insert into public.assignment_rules (org_id, name, team_id, priority) values (t.id('org'), 'Regla específica', :T1, 10);
select t.reset();
select t.ok('con dos reglas que aplican, gana la de menor número de prioridad', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null) in (:S1, :S2)));

-- ---- Una regla desactivada no cuenta
select t.as_user(:A);
update public.assignment_rules set active = false where name = 'Regla específica';
select t.reset();
-- (el Equipo General necesita alguien activo; si no, el motor también lo salta — eso se prueba aparte abajo)
select t.ok('equipo sin integrantes activos: se salta y, sin más reglas, no asigna', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null) is null));
update public.memberships set team_id = (select id from public.teams where name = 'Equipo General' and org_id = t.id('org')) where org_id = t.id('org') and user_id = :A;
select t.ok('una regla desactivada se salta, y sigue la siguiente por prioridad', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null) = :A));

-- ---- Una regla con horario: fuera de la ventana, no coincide
select t.as_user(:A);
delete from public.assignment_rules where org_id = t.id('org');
insert into public.assignment_rules (org_id, name, team_id, hours_start, hours_end, hours_days, timezone)
  values (t.id('org'), 'Solo en horario', :T1, '08:00', '17:00', '{1,2,3,4,5}', 'America/Bogota');
select t.reset();
-- un lunes a mediodía en Bogotá: dentro de horario
select t.ok('dentro del horario configurado, sí asigna', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null, '2026-10-05 12:00:00-05') is not null));
-- un sábado: fuera de los días permitidos
select t.ok('fuera del horario (sábado), no asigna a nadie', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null, '2026-10-03 12:00:00-05') is null));
-- un lunes muy temprano: fuera de la franja horaria
select t.ok('a la hora exacta de cierre (17:00) ya está fuera de horario', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null, '2026-10-05 17:00:30-05') is null));
select t.ok('fuera del horario (de madrugada), no asigna a nadie', (select app.pick_assignee(t.id('org'), 'whatsapp', t.id('widget'), null, '2026-10-05 05:00:00-05') is null));

-- ---- Permisos: solo quien tiene assignment_rules:manage puede ver/crear reglas
select t.as_user(:S1);
select t.ok('un vendedor no ve las reglas de distribución', (select count(*) = 0 from public.assignment_rules));
select t.throws('un vendedor no puede crear una regla', format('insert into public.assignment_rules (org_id, name, team_id) values (%L, ''Intento'', %L)', t.id('org'), :T1), '42501');
select t.reset();

-- ---- No se puede crear una regla con un equipo de otra organización
select t.as_user(:A); select t.save('org2', public.create_organization('Otra Org', 'otra-org-reglas')); select t.reset();
select t.as_user(:A);
select t.throws('un equipo de otra organización se rechaza', format('insert into public.assignment_rules (org_id, name, team_id) values (%L, ''Cruzada'', %L)', t.id('org2'), :T1), '23503');
select t.reset();

-- ---- start_widget_conversation: de punta a punta, con la región tomada del WIDGET
-- Widget instalado en la web de Medellín (región en su configuración; se guarda limpia).
select t.as_user(:A);
delete from public.assignment_rules where org_id = t.id('org');
update public.whatsapp_widgets set region = '  Medellín  ' where id = t.id('widget');
insert into public.teams (id, org_id, name, region) values (:T2, t.id('org'), 'Equipo Medellín', 'Medellín');
insert into public.assignment_rules (org_id, name, team_id, region, priority) values (t.id('org'), 'Medellín → Equipo Medellín', :T2, 'medellín', 10);
insert into public.assignment_rules (org_id, name, team_id, priority) values (t.id('org'), 'El resto → Bogotá', :T1, 100);
select t.reset();
update public.memberships set team_id = :T2 where org_id = t.id('org') and user_id = :A;   -- A: único integrante de Medellín
select t.ok('la región del widget se guarda sin espacios sobrantes', (select region = 'Medellín' from public.whatsapp_widgets where id = t.id('widget')));

select t.as_service();
select t.ok('start_widget_conversation sigue siendo exitoso con el motor de reglas conectado',
  (select (public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Pedro Prueba', '+573009990001', null, 'Hola', null, null, null, null, null, null, null) ->> 'ok')::boolean));
select t.reset();
select t.ok('el contacto nuevo cae en la regla de la región del widget (Medellín), no en la general',
  (select owner_id = :A and team_id = :T2 from public.customers where full_name = 'Pedro Prueba'));
select t.ok('el lead hereda el dueño asignado y guarda la región del widget en la atribución',
  (select owner_id = :A and raw_payload ->> 'region' = 'Medellín' from public.leads where contact_phone = '+573009990001'));
select t.ok('la conversación nueva sí consumió turno', (select last_assigned_to = :A from public.assignment_rule_state s join public.assignment_rules r on r.id = s.rule_id where r.name = 'Medellín → Equipo Medellín'));

-- Un widget SIN región: no coincide con la regla de Medellín, cae en la general (Bogotá, por turnos).
update public.whatsapp_widgets set region = null where id = t.id('widget');
select t.as_service();
select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Lucía Sin Región', '+573009990002', null, 'Hola', null, null, null, null, null, null, null);
select t.reset();
select t.ok('widget sin región: se salta la regla de región y aplica la general', (select owner_id in (:S1, :S2) from public.customers where full_name = 'Lucía Sin Región'));

-- ---- Un contacto que YA EXISTÍA no consume turno (tenga o no dueño)
select t.save('turno_antes', (select s.last_assigned_to from public.assignment_rule_state s join public.assignment_rules r on r.id = s.rule_id where r.name = 'El resto → Bogotá'));
select t.as_service();
select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Lucía Sin Región', '+573009990002', null, 'Otra vez', null, null, null, null, null, null, null);
select t.reset();
select t.ok('un contacto que ya existía (con dueño) no avanza el turno',
  (select s.last_assigned_to = t.id('turno_antes') from public.assignment_rule_state s join public.assignment_rules r on r.id = s.rule_id where r.name = 'El resto → Bogotá'));
select t.ok('…y no se le cambia el dueño', (select owner_id = t.id('turno_antes') from public.customers where full_name = 'Lucía Sin Región'));

-- Existente SIN dueño (creado antes de que hubiera reglas): sigue sin dueño y no consume turno.
select t.as_user(:A); select t.save('huerfano', (public.create_customer(t.id('org'), 'person', 'Cliente Viejo', '[{"type":"phone","value":"+573009990003"}]'::jsonb) ->> 'customer_id')::uuid); select t.reset();
update public.customers set owner_id = null where id = t.id('huerfano');
select t.as_service();
select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Cliente Viejo', '+573009990003', null, 'Hola', null, null, null, null, null, null, null);
select t.reset();
select t.ok('un contacto existente sin dueño sigue sin dueño (el widget no lo reasigna)', (select owner_id is null from public.customers where id = t.id('huerfano')));
select t.ok('…y tampoco consume turno',
  (select s.last_assigned_to = t.id('turno_antes') from public.assignment_rule_state s join public.assignment_rules r on r.id = s.rule_id where r.name = 'El resto → Bogotá'));

-- 'review' = se CREÓ un cliente nuevo (otro teléfono) que solo comparte nombre con otro: sí es nuevo, sí se asigna.
select t.as_service();
select public.start_widget_conversation(t.id('widget'), 'arkos.com.co', 'Lucía Sin Región', '+573009990004', null, 'Hola', null, null, null, null, null, null, null);
select t.reset();
select t.ok('el resultado de ingesta es review (mismo nombre, teléfono distinto)',
  (select exists (select 1 from public.leads where contact_phone = '+573009990004' and resolution = 'review')));
select t.ok('un cliente nuevo en revisión por nombre repetido sí se asigna y avanza el turno',
  (select c.owner_id in (:S1, :S2) and c.owner_id <> t.id('turno_antes')
     from public.customers c join public.customer_identifiers ci on ci.customer_id = c.id where ci.value = '+573009990004'));

-- ---- Seguridad: el motor y el RPC del widget solo los llama el servidor (service_role)
select t.as_user(:A);
select t.throws('un usuario autenticado no puede llamar app.pick_assignee (avanzaría turnos de cualquier org)',
  format('select app.pick_assignee(%L, ''whatsapp'', null, null)', t.id('org')), '42501');
select t.throws('un usuario autenticado no puede llamar start_widget_conversation directo (saltaría la ruta del servidor)',
  format('select public.start_widget_conversation(%L, ''arkos.com.co'', ''X'', ''+573000000000'', null, null, null, null, null, null, null, null, null)', t.id('widget')), '42501');
select t.reset();
select t.as_anon();
select t.throws('anon no puede llamar start_widget_conversation directo',
  format('select public.start_widget_conversation(%L, ''arkos.com.co'', ''X'', ''+573000000000'', null, null, null, null, null, null, null, null, null)', t.id('widget')), '42501');
select t.reset();

-- ---- Datos inválidos se rechazan al guardar, no en tiempo de ejecución
insert into public.teams (org_id, name) values (t.id('org2'), 'Equipo Org2');
select t.as_user(:A);
select t.throws('una zona horaria inexistente se rechaza al guardar',
  format('insert into public.assignment_rules (org_id, name, team_id, timezone) values (%L, ''TZ mala'', %L, ''America/Bogta'')', t.id('org'), :T1), '22023');
select t.throws('un horario con solo hora de inicio se rechaza',
  format('insert into public.assignment_rules (org_id, name, team_id, hours_start) values (%L, ''Medio horario'', %L, ''08:00'')', t.id('org'), :T1), '23514');
select t.throws('un widget de otra organización se rechaza',
  format('insert into public.assignment_rules (org_id, name, team_id, widget_id) values (%L, ''Widget ajeno'', (select id from public.teams where org_id = %L limit 1), %L)', t.id('org2'), t.id('org2'), t.id('widget')), '23503');
select t.reset();

-- ---- Borrar el widget borra sus reglas (antes la regla quedaba como «cualquier widget» y se ampliaba sola)
select t.as_user(:A);
delete from public.assignment_rules where org_id = t.id('org');
insert into public.assignment_rules (org_id, name, team_id, widget_id) values (t.id('org'), 'Solo este widget', :T1, t.id('widget'));
delete from public.whatsapp_widgets where id = t.id('widget');
select t.reset();
select t.ok('al borrar el widget, su regla específica desaparece en vez de aplicar a todos',
  (select count(*) = 0 from public.assignment_rules where name = 'Solo este widget'));

rollback;
\echo ✔ DISTRIBUCIÓN AUTOMÁTICA DE CONVERSACIONES: TODAS LAS PRUEBAS PASARON
