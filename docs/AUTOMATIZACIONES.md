# Automatizaciones — qué se construyó (Fase 8)

## Diagnóstico y decisión de alcance
La arquitectura original describía un motor de automatización con un grafo (disparador → condición →
acción → **espera** → rama → fin), con pasos programados. Ese diseño no encaja con este CRM: como ya se
confirmó en la Fase 7 (Secuencias), el sistema no ejecuta tareas propias en segundo plano.

**Hallazgo importante:** al investigar, se encontró que **ya existe un despachador de eventos** construido y
probado (`app.claim_events`, `/api/cron/dispatch-events`), pensado para que un programador **externo**
(pg_cron de Supabase o Vercel Cron) lo llame cada pocos minutos — ya documentado en `docs/DEPLOY.md` §5,
pero sin nadie llamándolo todavía en la mayoría de instalaciones. Esta fase se apoya en esa pieza ya
construida en vez de inventar infraestructura nueva.

**Diseño final:** una regla es «cuando ocurre X (un evento que el sistema ya emite) y se cumplen unas
condiciones simples, entonces ejecuta estas acciones». Las acciones se ejecutan **con la identidad de quien
creó la regla** (se simula su sesión por la duración de la llamada, dentro de una función seguridad-definer
solo accesible por `service_role`), así se reutilizan tal cual las funciones que ya existen y ya están
probadas — nada de lógica de negocio duplicada, y los mismos límites de permisos de esa persona aplican.

## Qué se construyó
- **`automation_rules`** / **`automation_runs`** (migración `0026`). Los permisos `automations:read` /
  `automations:manage` ya existían desde la Fase 1, asignados a `manager`, `sales_manager` y `marketing`
  (no a `sales_agent`, a diferencia de Secuencias — un diseño más restrictivo, ya decidido).
- **Disparadores** (eventos que el sistema ya emite): lead creado, oportunidad ganada/perdida, oportunidad
  cambia de etapa, actividad registrada, tarea completada.
- **Condiciones**: comparaciones simples sobre un campo del evento (igual, distinto, mayor/menor que).
- **Acciones**: crear tarea, agregar etiqueta, asignar responsable, inscribir en una Secuencia (Fase 7).
- **Idempotencia**: una llave única (regla + evento) impide que una automatización se repita si el
  despachador reintenta el mismo evento tras una falla parcial.
- Pantalla `/automations`: lista con activar/pausar, crear con un constructor de condiciones y acciones, y
  el detalle de cada regla con su historial de ejecuciones.
- El manejador se registró en el despachador ya existente (`src/server/events/handlers.ts`), sin tocar su
  código: cada uno de los 6 disparadores apunta al mismo manejador nuevo.

## Cinco errores reales que encontré y corregí en el camino
1. Registré por error una tabla en la fusión de clientes que no tiene columna `customer_id` — lo detecté
   antes de aplicar nada.
2. Me faltaba el envoltorio en el esquema `public` para que el despachador (que usa la API REST) pudiera
   llamar a la función de ejecución — igual que ya existe para las funciones internas de otros workers.
3. **Un error de mi propia prueba, no del código:** usé un ID de oportunidad inventado; la función de crear
   tarea correctamente lo rechazó por no existir. Confirmado con una reproducción manual paso a paso.
4. **Un hallazgo real del diseño de permisos:** `sales_agent` no tiene acceso a Automatizaciones (a
   diferencia de Secuencias). Mi prueba asumía el rol equivocado; ya corregida.
5. Llamé a una función interna restringida a `service_role` con el rol equivocado en una prueba.

## Verificación
- 480 pruebas unitarias, suite SQL completa (con mutaciones sobre los 4 puntos críticos: permisos,
  idempotencia, regla inactiva, condiciones), y 262 de integración contra Postgres/PostgREST reales.
- 11 comprobaciones en navegador real: crear una regla con condición y acción, dispararla exactamente como
  lo haría el despachador (`run_automation_rule` vía la API REST), confirmar en la base de datos que la
  acción se ejecutó de verdad, ver el historial, pausar/activar, y responsive en móvil.

## Para que esto funcione en producción
Automatizaciones depende de que el despachador de eventos se ejecute periódicamente — ver
`docs/DEPLOY.md` §5 (pg_cron de Supabase, recomendado; o Vercel Cron). Si esa parte no está configurada, las
reglas se crean y se ven bien en pantalla, pero nunca se disparan solas.
