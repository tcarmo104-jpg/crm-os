#!/usr/bin/env bash
# Prueba de concurrencia real: muchas conexiones simultáneas resolviendo identidades.
# Verifica que NO haya clientes duplicados, errores ni deadlocks. Requiere la BD ya migrada
# (la deja con datos de prueba; test-db.sh la recrea en cada ejecución).
set -euo pipefail
DB="${TEST_DB:-crm_test}"
PSQL=(psql -X -q -tA -v ON_ERROR_STOP=1 -d "$DB")
fail() { echo "✘ CONCURRENCIA: $1"; exit 1; }

UID_="cccccccc-1111-0000-0000-000000000001"
ORG=$("${PSQL[@]}" <<SQL | tail -1
insert into auth.users (id, email) values ('$UID_', 'conc@x.test');
select set_config('request.jwt.claim.sub', '$UID_', false) \gset
select public.create_organization('Concurrencia', 'concurrencia');
SQL
)
[ -n "$ORG" ] || fail "no se pudo crear la organización de prueba"

count() { "${PSQL[@]}" -c "$1"; }
call() { "${PSQL[@]}" -c "select public.ingest_lead('$ORG', $1)" >/dev/null; }
export -f call; export ORG DB

echo "→ Escenario 1: 40 leads simultáneos con el MISMO teléfono (12 conexiones en paralelo)"
seq 1 40 | xargs -P 12 -I{} bash -c "psql -X -q -tA -v ON_ERROR_STOP=1 -d \$DB -c \"select public.ingest_lead('\$ORG', jsonb_build_object('name','Concurrente','source','load','external_id','s1-{}','identifiers', jsonb_build_array(jsonb_build_object('type','phone','value','+573109990000'), jsonb_build_object('type','external','value','s1-ext-{}'))))\" >/dev/null" \
  || fail "alguna llamada falló (error o deadlock) en el escenario 1"
[ "$(count "select count(*) from customers where org_id='$ORG' and deleted_at is null")" = "1" ] || fail "escenario 1: se crearon clientes duplicados"
[ "$(count "select count(*) from leads where org_id='$ORG' and source='load'")" = "40" ] || fail "escenario 1: faltan leads"
[ "$(count "select count(*) from customer_identifiers where org_id='$ORG'")" = "41" ] || fail "escenario 1: identificadores inesperados"

echo "→ Escenario 2: 40 leads simultáneos sobre 4 teléfonos distintos"
seq 1 40 | xargs -P 12 -I{} bash -c "n=\$(( {} % 4 )); psql -X -q -tA -v ON_ERROR_STOP=1 -d \$DB -c \"select public.ingest_lead('\$ORG', jsonb_build_object('name','Multi '||\$n,'source','multi','external_id','s2-{}','identifiers', jsonb_build_array(jsonb_build_object('type','phone','value','+57311000000'||\$n))))\" >/dev/null" \
  || fail "alguna llamada falló en el escenario 2"
[ "$(count "select count(*) from customers where org_id='$ORG' and full_name like 'Multi %'")" = "4" ] || fail "escenario 2: se esperaban exactamente 4 clientes"

echo "→ Escenario 3: 30 leads simultáneos con los MISMOS 2 identificadores en orden alterno (prueba de deadlocks)"
seq 1 30 | xargs -P 12 -I{} bash -c "if [ \$(( {} % 2 )) -eq 0 ]; then a='+573121110001'; b='+573121110002'; else a='+573121110002'; b='+573121110001'; fi; psql -X -q -tA -v ON_ERROR_STOP=1 -d \$DB -c \"select public.ingest_lead('\$ORG', jsonb_build_object('name','Par','source','par','external_id','s3-{}','identifiers', jsonb_build_array(jsonb_build_object('type','phone','value','\$a'), jsonb_build_object('type','phone','value','\$b'))))\" >/dev/null" \
  || fail "alguna llamada falló (posible deadlock) en el escenario 3"
[ "$(count "select count(distinct customer_id) from leads where org_id='$ORG' and source='par'")" = "1" ] || fail "escenario 3: se dividió en varios clientes"
[ "$(count "select count(*) from identity_reviews where org_id='$ORG'")" = "0" ] || fail "escenario 3: no debería haber revisiones"

echo "→ Escenario 4: 40 personas mueven LA MISMA oportunidad a la vez (el historial debe ser una cadena íntegra)"
OPP=$("${PSQL[@]}" <<SQL | tail -1
select set_config('request.jwt.claim.sub', '$UID_', false) \gset
select public.create_opportunity((select id from customers where org_id = '$ORG' limit 1), 'Carrera de estados', 100);
SQL
)
[ -n "$OPP" ] || fail "no se pudo crear la oportunidad de prueba"
export OPP UID_
seq 1 40 | xargs -P 12 -I{} bash -c "idx=\$(( {} % 4 )); psql -X -q -tA -v ON_ERROR_STOP=1 -d \$DB -c \"select set_config('request.jwt.claim.sub', '\$UID_', false); select public.move_opportunity('\$OPP', (select id from pipeline_stages where pipeline_id = (select pipeline_id from opportunities where id = '\$OPP') and kind = 'open' order by position offset \$idx limit 1))\" >/dev/null" \
  || fail "alguna llamada falló (error o deadlock) en el escenario 4"
[ "$(count "select bool_and(from_state is not distinct from prev_to) from (select from_state, lag(to_state) over (order by occurred_at, id) prev_to from state_transitions where entity_id = '$OPP') x")" = "t" ] \
  || fail "escenario 4: el historial de transiciones NO es una cadena continua"
[ "$(count "select (select to_state from state_transitions where entity_id = '$OPP' order by occurred_at desc, id desc limit 1) = (select s.name from opportunities o join pipeline_stages s on s.id = o.stage_id where o.id = '$OPP')")" = "t" ] \
  || fail "escenario 4: la última transición no coincide con la etapa actual"

echo "→ Escenario 5: 12 personas completan LA MISMA tarea a la vez (solo una puede lograrlo)"
TASK=$("${PSQL[@]}" <<SQL | tail -1
select set_config('request.jwt.claim.sub', '$UID_', false) \gset
select public.create_task('$ORG', 'Carrera de tareas');
SQL
)
export TASK
seq 1 12 | xargs -P 12 -I{} bash -c "psql -X -q -tA -d \$DB -c \"select set_config('request.jwt.claim.sub', '\$UID_', false); select public.complete_task('\$TASK')\" >/dev/null 2>&1 || true"
[ "$(count "select count(*) from domain_events where entity_id = '$TASK' and type = 'task.completed'")" = "1" ] || fail "escenario 5: la tarea se completó más de una vez (o ninguna)"
[ "$(count "select status from tasks where id = '$TASK'")" = "done" ] || fail "escenario 5: la tarea no quedó completada"

echo "→ Escenario 6: 40 cotizaciones creadas a la vez (numeración correlativa: sin repetidos ni huecos)"
seq 1 40 | xargs -P 12 -I{} bash -c "psql -X -q -tA -v ON_ERROR_STOP=1 -d \$DB -c \"select set_config('request.jwt.claim.sub', '\$UID_', false); select public.create_quote('\$OPP')\" >/dev/null" \
  || fail "alguna llamada falló en el escenario 6"
[ "$(count "select count(distinct number) from quotes where opportunity_id = '$OPP'")" = "40" ] || fail "escenario 6: números de cotización repetidos"
[ "$(count "select max(substring(number from 5)::int) from quotes where opportunity_id = '$OPP'")" = "40" ] || fail "escenario 6: hay huecos en la numeración"

echo "→ Escenario 7: 10 personas registran LA MISMA venta a la vez (solo una puede lograrlo)"
SALEQ=$("${PSQL[@]}" <<SQL | tail -1
select set_config('request.jwt.claim.sub', '$UID_', false) \gset
select public.create_quote(public.create_opportunity((select id from customers where org_id = '$ORG' limit 1), 'Venta en carrera', 100)) as q \gset
select public.add_quote_item(:'q', null, 'Producto', 1, 1000, 0, 19);
select public.send_quote(:'q');
select public.accept_quote(:'q');
select :'q';
SQL
)
[ -n "$SALEQ" ] || fail "no se pudo preparar la cotización aceptada"
export SALEQ
seq 1 10 | xargs -P 10 -I{} bash -c "psql -X -q -tA -d \$DB -c \"select set_config('request.jwt.claim.sub', '\$UID_', false); select public.create_sale('\$SALEQ')\" >/dev/null 2>&1 || true"
[ "$(count "select count(*) from sales where quote_id = '$SALEQ' and status <> 'cancelled'")" = "1" ] || fail "escenario 7: se registró más de una venta (o ninguna) para la misma cotización"
[ "$(count "select count(*) from tasks where description like 'Seguimiento postventa de VTA-%' and opportunity_id = (select opportunity_id from quotes where id = '$SALEQ')")" = "3" ] || fail "escenario 7: el seguimiento postventa se duplicó"

echo "→ Escenario 8: el MISMO mensaje entregado 15 veces a la vez por Meta (se registra una sola vez)"
CH=$("${PSQL[@]}" <<SQL | tail -1
select set_config('request.jwt.claim.sub', '$UID_', false) \gset
select public.create_channel('$ORG', 'Canal prueba', '555000111222', null, 'EAAB-token-abcdefghijklmnopqrstuvwxyz');
SQL
)
[ -n "$CH" ] || fail "no se pudo crear el canal de prueba"
seq 1 15 | xargs -P 15 -I{} bash -c "psql -X -q -tA -d \$DB -c \"select public.ingest_whatsapp_message('555000111222', '573777000111', 'Contacto Carrera', 'wamid.SAME', 'text', 'hola', now())\" >/dev/null 2>&1 || true"
[ "$(count "select count(*) from messages where external_id = 'wamid.SAME'")" = "1" ] || fail "escenario 8: el mensaje se registró más de una vez (o ninguna)"

echo "→ Escenario 9: 15 primeros mensajes DISTINTOS del mismo contacto nuevo, a la vez (1 cliente, 1 lead, 1 conversación)"
seq 1 15 | xargs -P 15 -I{} bash -c "psql -X -q -tA -d \$DB -c \"select public.ingest_whatsapp_message('555000111222', '573888000222', 'Nuevo Simultáneo', 'wamid.N{}', 'text', 'mensaje {}', now())\" >/dev/null 2>&1 || true"
[ "$(count "select count(*) from conversations where thread_key = '573888000222'")" = "1" ] || fail "escenario 9: se duplicó la conversación"
[ "$(count "select count(*) from customer_identifiers where value = '+573888000222'")" = "1" ] || fail "escenario 9: se duplicó el cliente"
[ "$(count "select count(*) from leads l join customer_identifiers i on i.customer_id = l.customer_id where i.value = '+573888000222'")" = "1" ] || fail "escenario 9: se duplicó el lead"
[ "$(count "select count(*) from messages m join conversations c on c.id = m.conversation_id where c.thread_key = '573888000222'")" = "15" ] || fail "escenario 9: se perdieron o duplicaron mensajes"

echo "→ Escenario 10: 12 procesos reclaman EL MISMO mensaje saliente a la vez (solo uno puede enviarlo)"
MSG=$("${PSQL[@]}" <<SQL | tail -1
select set_config('request.jwt.claim.sub', '$UID_', false) \gset
select public.queue_message((select id from conversations where thread_key = '573888000222'), 'respuesta única');
SQL
)
[ -n "$MSG" ] || fail "no se pudo encolar el mensaje"
export MSG
seq 1 12 | xargs -P 12 -I{} bash -c "psql -X -q -tA -d \$DB -c \"select public.claim_outbound('\$MSG') is not null\" 2>/dev/null" > /tmp/claims.txt
[ "$(grep -c '^t$' /tmp/claims.txt)" = "1" ] || fail "escenario 10: más de un proceso reclamó el mismo mensaje ($(grep -c '^t$' /tmp/claims.txt))"
[ "$(count "select attempts from messages where id = '$MSG'")" = "1" ] || fail "escenario 10: el mensaje tiene más de un intento"

echo "✔ CONCURRENCIA OK: sin duplicados, sin errores, sin deadlocks, historial y numeración íntegros"
