# Arquitectura — Sistema operativo comercial (CRM)

Documento vivo. Refleja lo **construido y verificado** (Fase 1) y las decisiones que guían el resto.

## 1. Cómo se unifican los dos prompts

Los dos prompts describen el mismo producto desde ángulos distintos. Esta es la síntesis que se implementa:

| Tema | Prompt 1 (Customer 360) | Prompt 2 (Execution) | Decisión |
|---|---|---|---|
| Entidad central | `customers` permanente; lead = señal | `lead` como centro del flujo | **Customer-first.** El lead es una señal de entrada que se resuelve contra un customer existente (Identity Resolution) *antes* de crear nada. El flujo del Prompt 2 (captura → normalización → deduplicación → calificación → asignación…) se conserva íntegro. |
| Stream de eventos | `customer_events` | eventos `LeadCreated`, … | **Un solo stream `domain_events`** (outbox). El timeline del cliente es una vista filtrada por `customer_id`. Nombres en `entidad.accion` (`quote.accepted`). |
| Servicios | tabla `services` | "productos y servicios" | Una sola tabla `products` con `kind`. |
| Contactos/empresas | `contacts`, `companies`, `customers` | ídem | `customers` con `type` (persona/empresa) + relación persona↔empresa. |
| "Super Admin" | rol | rol | Es el **propietario de la organización**. El operador de plataforma **no** es un rol de tenant: usa `service_role` fuera de la app. Evita un rol con visibilidad cross-tenant dentro de RLS. |
| Estados | — | "nunca estados ambiguos" | Toda transición de estado se registra (anterior, nuevo, usuario, fecha, motivo, fuente) mediante un trigger genérico (Fase 3). |

## 2. Arquitectura general

Monolito modular en TypeScript (no microservicios: el volumen objetivo no lo justifica; se escala con workers y particionado).

```
Next.js (UI + route handlers finos)
   │  cliente Supabase con el JWT del usuario  → RLS aplica siempre
   ▼
services/  (lógica comercial)  →  repositories/  →  PostgreSQL (RLS)
                                                         │ outbox (domain_events)
                                                         ▼
workers (service_role): dispatcher → timeline · scoring · secuencias · automatización · IA · analytics · notificaciones
```

Reglas:
- **Ninguna lógica comercial en componentes de UI.**
- El backend consulta con el **JWT del usuario**, nunca con `service_role`. `service_role` solo en workers.
- Integraciones (Meta, email, calendario) son **adaptadores** desacoplados con la misma interfaz (`receive / send / normalize`).
- IA detrás de una interfaz de proveedor intercambiable; toda llamada se registra en `ai_interactions`.

## 3. Seguridad (implementado en Fase 1)

- **RLS en todas las tablas** con `org_id`; una prueba automática falla si alguna tabla de `public` queda sin RLS.
- **Deny by default:** `anon` sin privilegios; `authenticated` solo lo explícito (privilegios por columna donde aplica, p. ej. no se puede cambiar el `slug` de la organización).
- **RBAC con alcance:** cada permiso se concede con alcance `own | team | org`. Las tablas de dominio usarán `app.can_access_row(org_id, 'leads:read', owner_id, team_id)`.
- **FK compuestas** `(id, org_id)` impiden referenciar registros de otra organización.
- **Guardas de propiedad:** solo un `super_admin` puede otorgar/quitar `super_admin`; una organización siempre conserva al menos uno; nadie puede auto-escalarse.
- **Auditoría append-only** (trigger + sin privilegios de UPDATE/DELETE), con diff de columnas cambiadas, actor e IP.
- **Outbox no legible por clientes:** `domain_events` solo accesible por workers.
- Pendiente de fases posteriores: cifrado de tokens de Meta (Supabase Vault), verificación de firma de webhooks, rate limiting en el borde, 2FA.

## 4. Modelo de datos

**Construido (Fases 1 y 1b):** `organizations`, `profiles`, `teams`, `memberships`, `roles`, `permissions`, `role_permissions`, `invitations`, `audit_logs`, `domain_events`.

**Siguientes (con la relación central):**

```
organization → teams → users (memberships)
organization → customers ─┬─ customer_identifiers  (teléfono/email/ID externo normalizados, únicos por org)
                          ├─ leads                 (señales de entrada; N por customer)
                          ├─ conversations → messages
                          ├─ opportunities ─┬─ quotes → quote_items
                          │                 └─ sales  → sale_items (snapshot de precios; nunca se sobrescribe)
                          ├─ post_sale_cases
                          └─ activities / tasks    (polimórficas: entity_type + entity_id)
```

Decisiones de modelado a respetar: `next_actions` materializada (recalculada por eventos); scores como snapshots versionados en una sola tabla `scores`; `domain_events` y `audit_logs` se particionarán por mes cuando el volumen lo pida (antes de la Fase 5).

## 5. Ciclos de vida

- **Customer:** la etapa (prospecto → activo → recurrente → inactivo → reactivación) es **derivada de eventos**, no editada a mano. No bloquea nuevas oportunidades.
- **Oportunidad:** nueva necesidad → calificación → diagnóstico → cotización → seguimiento → negociación → ganada/perdida. Ganada crea la venta y abre el *post-sale journey* (entrega → confirmación → satisfacción → soporte → recompra).

## 6. Sales Execution Engine

- Salida: filas en `next_actions` (customer, entidad, acción, prioridad, motivo, vence_en).
- **v1 basada en reglas** (auditable): p. ej. cotización enviada sin actividad > 24 h → "hacer seguimiento". La IA ajusta prioridad y redacta el guion sugerido.
- Prioridad = valor × probabilidad × urgencia SLA.
- SLA como timers (jobs programados) → alerta → escalamiento → manager.
- **Execution Rate** = acciones ejecutadas a tiempo ÷ acciones esperadas.
- Separa problemas de ejecución de problemas de calidad de lead: "vendió poco" vs "cumplió el 96 % del proceso".

## 7. Automatización y secuencias

Grafo JSON versionado (trigger → condición → acción → espera → rama → fin) con `automation_runs` y pasos registrados. Esperas = jobs programados con clave de idempotencia. Condiciones de parada globales (responde, agenda, compra) y flag `do_not_contact` que **todo envío** verifica.

## 8. Omnicanal

Webhook → verificación de firma → `raw_events` → normalización + deduplicación por ID externo → **Identity Resolution** → conversación → clasificación de intención → acción (oportunidad / seguimiento / recompra / postventa / soporte / reclamo / información). WhatsApp: ventana de 24 h y plantillas aprobadas.

**Identity Resolution:** confianza alta → une automáticamente; media → sugiere merge (cola de revisión humana); baja → cliente nuevo. Teléfonos compartidos (familias, empresas) hacen inviable un matching 100 % automático.

## 9. IA

Asíncrona, registrada, con salida JSON estructurada y nivel de confianza (confianza baja ⇒ no actúa, pide revisión). **AI Business Analyst:** capa semántica de métricas predefinidas que respetan RLS (no SQL libre), y cita de dónde sale cada cifra. Human-in-the-loop obligatorio en descuentos, cierres, mensajes sensibles y cambios críticos.

## 10. Plan por fases (reordenado)

| Fase | Contenido | Estado |
|---|---|---|
| **1** | Multi-tenancy, RBAC con alcance, RLS, auditoría, event stream + pruebas | ✅ construido y verificado |
| **1b** | Invitaciones, app Next.js (login, selector de organización, menú lateral, miembros, equipos), endpoint de eventos, CI | ✅ construido (ver §13 para lo verificado y lo pendiente) |
| **2** | Customer 360, Identity Resolution, captura de leads (CSV y API con llave), *do-not-contact*, campos personalizados, revisión y fusión de duplicados | ✅ construido (ver §14 para lo verificado y lo pendiente) |
| **3** | Pipelines, oportunidades, tareas/actividades, log de transiciones de estado | ✅ construido (ver §15 para lo verificado y lo pendiente) |
| **4** | Productos, cotizaciones, ventas, postventa | ✅ construido y verificado (ver §16) |
| **5** | **Inbox mínimo + WhatsApp/Meta** *(adelantado)* | ✅ construido (ver §17; **sin probar contra Meta real**) |
| 6 | Motor de asignación, lead scoring, SLA | |
| 7 | Sales Execution Engine (Next Best Action) + secuencias | |
| 8 | Automation Builder | |
| 9 | IA (asistente, intención, copiloto) | |
| 10 | Analytics y dashboards | |
| 11 | Call Insights, coaching, Sales Playbook | |
| 12 | AI Business Analyst | |
| 13 | Endurecimiento y escalabilidad | |

**Por qué el inbox va antes del motor de ejecución:** sin conversaciones reales, el Next Best Action no tiene datos con los que trabajar, y el volumen de 17k conversaciones/mes es donde más rápido aparecen los problemas de identidad y de rendimiento.

## 11. Decisiones abiertas (necesito tu criterio)

1. ~~Visibilidad de clientes para vendedores~~ → **Resuelta** (ver §12).
2. **Roles personalizados por organización:** la estructura ya lo soporta (`roles.org_id`); falta la UI y la política de escritura.
3. **Proveedor de IA y de transcripción de llamadas:** condiciona la Fase 9 y la 11.

## 12. Regla de visibilidad de clientes (decidida)

| Rol | Clientes que ve |
|---|---|
| super_admin, admin, manager | Todos |
| sales_manager | Los de su equipo |
| sales_agent | Solo los suyos |
| marketing, customer_service, analyst, viewer | Solo los que se les asignen (alcance `own`) |

Implementada en la migración `0004` y fijada por pruebas (una prueba falla si otro rol obtiene alcance `org` sobre clientes).

**Consecuencias de diseño para la Fase 2 (Identity Resolution):**
- La resolución de identidad corre en el **servidor/worker**, no con los permisos del vendedor. Así detecta que el cliente ya existe aunque lo atienda otro vendedor, sin exponer sus datos.
- Cuando un lead o mensaje corresponde a un cliente existente, **se enruta al propietario actual** (o a la regla de asignación), no se crea un duplicado.
- Si un vendedor intenta crear a mano un cliente que ya existe con otro propietario, ve un mensaje genérico ("este contacto ya está registrado; se notificó a tu manager") y el manager recibe la alerta. No se revela quién es el propietario ni sus datos.
- `marketing`, `customer_service`, `analyst` y `viewer` quedan sin acceso a la base completa de clientes. **Servicio al cliente** trabajará sobre los casos que se le asignen y los reportes usarán la capa semántica agregada; si en la práctica necesita buscar clientes libremente, se le otorgará alcance `org` de forma explícita.

## 13. Fase 1b — decisiones, verificación y deuda conocida

**Decisiones**
- **Next.js 15.5 (App Router)** en la raíz del repo (Vercel no necesita configuración). Se evita Next 16 por ahora: renombra el archivo de middleware y otras APIs; se migra cuando la base esté estable.
- **Capas:** `app/` (páginas y server actions, solo orquestan) → `services/` (validación con zod y reglas) → `repositories/` (únicas consultas a Supabase) → Postgres con RLS. La organización activa **siempre** sale de la sesión validada en servidor, nunca de un campo de formulario.
- **Invitaciones:** el token (~244 bits) se muestra una vez y solo se guarda su SHA-256. Aceptar exige sesión con **el mismo correo y verificado**. Reinvitar invalida la invitación anterior. No se invita como `super_admin`: se invita como admin y luego se promueve.
- **Procesos de fondo en Vercel:** sin procesos permanentes. El *dispatcher* reclama lotes cortos de `domain_events` (`SKIP LOCKED`), con reintentos y dead-letter, y lo dispara `pg_cron` cada minuto contra `/api/cron/dispatch-events` (protegido por `CRON_SECRET`). Los handlers se registran en `src/server/events/handlers.ts` sin tocar el dispatcher; deben ser idempotentes (entrega al menos una vez).
- **Menú:** estado (colapsado, grupos plegados) persistido en cookie para que el servidor pinte lo correcto sin parpadeo. Los módulos aún no construidos aparecen **deshabilitados con su fase**, no como enlaces falsos.

**Verificado**
- 115+ comprobaciones SQL (aislamiento, RBAC, invitaciones, auditoría, eventos) contra PostgreSQL 16; mutaciones de seguridad inyectadas a propósito son detectadas.
- 33 pruebas unitarias (dispatcher, mapeo de errores, validación, anti *open-redirect*, comparación de secreto en tiempo constante).
- `tsc` sin errores, `next build` correcto, y arranque real del servidor: rutas privadas redirigen a login, cron responde 401 sin secreto, cabeceras de seguridad presentes.

**NO verificado todavía (hacerlo en staging)**
- Los flujos completos contra un proyecto Supabase real (registro → confirmación → organización → invitación → aceptación). Las consultas con relaciones embebidas de PostgREST y el envío de correos de Auth solo se pueden confirmar allí.
- Revisión visual en navegador y pruebas de accesibilidad con lector de pantalla.
- Recomendado como siguiente paso: pruebas end-to-end (Playwright) contra staging.

**Deuda conocida (priorizada)**
1. Envío de invitaciones por correo (hoy se copia el enlace). Requiere proveedor de email; se conecta como handler de `invitation.created`.
2. Rate limiting en el borde (hoy solo el de Supabase Auth y un tope de 5 organizaciones por usuario).
3. Content-Security-Policy estricta (hoy hay cabeceras básicas).
4. Favoritos, recientes y paleta de comandos del menú: se hacen junto con la búsqueda global (Fase 2), cuando haya datos que buscar.
5. Página de configuración de la organización y roles personalizados.
6. Rotación de la clave `service_role` y monitoreo de errores (Sentry o equivalente) antes de producción.

## 14. Fase 2 — decisiones, verificación y deuda conocida

**Decisiones**
- **Identidad:** un identificador (teléfono E.164, correo, usuario de Instagram/Facebook) pertenece a **un solo cliente por organización** (índice único). La resolución (`app.resolve_customer`) se serializa con `pg_advisory_xact_lock` por identificador **en orden estable** (sin duplicados en paralelo ni deadlocks). Identificador exacto → se une al existente. Mismo nombre (2+ palabras) sin identificador común → se crea el cliente y se abre una **revisión humana**. Identificadores de dos clientes distintos en un mismo mensaje → *conflicto*, se usa el más antiguo y se abre revisión. **Nunca se fusiona automáticamente.**
- **Normalización antes de la BD:** el servidor normaliza (`src/lib/identity.ts`) y la BD **vuelve a validar** con restricciones CHECK. `nameKey()` (TS) es espejo exacto de `app.normalize_name` (SQL); ambas unen acentos combinados (NFC). Un «00» inicial se lee como «+» (la librería lo tomaba por código de operador y creaba números de otro país).
- **Alta manual por un vendedor:** si el contacto ya existe y no es suyo → respuesta genérica (`duplicate_hidden`), **no se enriquece ni se toca** el cliente ajeno, y queda una alerta en *Duplicados* solo para managers/admin (regla de §12).
- **«No contactar»:** cualquiera con acceso al cliente lo activa; **solo manager/admin lo levanta**; al fusionar se conserva (OR). Los leads de un cliente «no contactar» se registran, y el evento lo marca para que las automatizaciones futuras lo respeten (aún no existen: Fases 7–8).
- **Fusión (`merge_customers`)**, solo manager/admin: mueve identificadores, leads y eventos al cliente más antiguo, une datos vacíos, archiva (no borra) al absorbido. **Una prueba estructural falla si alguna tabla nueva referencia a `customers` sin estar cubierta por la fusión** (Fases 3–4 deberán actualizarla).
- **Leads = señales:** todo lead (API, CSV) pasa por `app.ingest_lead_core`. Idempotente con `(org, fuente, external_id)`. El lead **sigue al propietario** del cliente; los leads abiertos siguen si se reasigna. Cliente nuevo por API/CSV queda **sin asignar** (lo reparte un manager; el motor de asignación llega en la Fase 6). Quien importa sin ver toda la cartera queda como propietario de lo importado.
- **API pública `POST /api/v1/leads`:** llave `crm_…` (256 bits) mostrada una vez, en BD solo el SHA-256; límite por llave (120/min por defecto) aplicado **antes** de leer el cuerpo; tope de 32 KB; respuesta **sin datos del cliente** (no revela si ya existía). Usa `service_role` solo para dos RPC (`api_authenticate`, `ingest_lead`) y para leer el *locale* de la organización; es una excepción documentada a «`service_role` solo en `src/server/`» porque no hay sesión de usuario.
- **Campos personalizados:** definiciones por organización y entidad (clientes, leads); valores en `jsonb` **validados en la BD por tipo** (texto, número, fecha, listas, sí/no, moneda, enlace, teléfono, correo). Clave y tipo inmutables; se archivan, no se borran (los archivados siguen siendo claves conocidas, para no romper datos históricos ni fusiones).
- **Auditoría:** ahora excluye `token_hash`, `key_hash` y `raw_payload` (datos crudos de entrada).
- **Importación CSV:** hasta 5.000 filas / 2 MB; coma, punto y coma o tabulador; UTF-8 o Windows-1252 (Excel); rechaza `.xlsx`; encabezados en español/inglés con o sin acentos; cada fila se procesa de forma aislada (una mala no revierte las demás); lotes de 200.

**Verificado**
- **SQL (PostgreSQL 16):** 285 aserciones en 5 suites (Fase 2: identidad/visibilidad/fusión/DNC 74, ingesta/API/llaves 56, campos personalizados 34).
- **Concurrencia real** (`scripts/test-concurrency.sh`, 12 conexiones): 40 leads con el mismo teléfono → 1 cliente; 40 sobre 4 teléfonos → 4; 30 con dos identificadores en orden alterno → 1 cliente, sin deadlocks. Quitando los bloqueos, la prueba falla.
- **Integración contra PostgREST real** (`npm run test:integration`, 17 pruebas): los repositorios y la ruta de la API tal cual, con JWT reales y RLS. Cubre búsqueda (incluye entradas hostiles), paginación por cursor con `created_at` idéntico, RPC, visibilidad por rol, fusión, campos, y la API (201/200/400/401/422/429, idempotencia, revocación).
- **Pruebas de mutación:** vulnerabilidades inyectadas a propósito (fuga de duplicados, enriquecimiento ajeno, levantar DNC sin permiso, visibilidad total, DNC perdido al fusionar, sin límite de peticiones, sin bloqueos, búsqueda sin sanear, cursor sin desempate) son detectadas. Dos no lo eran al principio: se corrigieron **las pruebas**, no el código.
- **Unitarias:** 89 (normalización, CSV, cursor, llaves, esquema y importación, línea de tiempo, errores). `tsc` limpio; `next build` correcto con el entorno de CI; sin secretos en el bundle del cliente.

**NO verificado todavía**
- Nada se ha ejecutado contra un **proyecto Supabase real** (ver la lista de 15 minutos al final de `docs/DEPLOY.md`). PostgREST local no equivale a Supabase en todo (extensiones, `auth`, límites de la plataforma).
- **Las pantallas nunca se han abierto en un navegador**: se compilan y sus consultas están probadas, pero no hay revisión visual, de accesibilidad ni pruebas end-to-end (Playwright).
- Rendimiento con volumen (17.000 conversaciones/mes → decenas de miles de clientes): índices razonables, sin *benchmark*. La búsqueda por nombre usa `ilike '%…%'` (sin índice trigram todavía).

**Deuda conocida (priorizada)**
1. **Notificaciones:** hoy la alerta al manager es la cola de *Duplicados* (no hay campana ni correo). Se resuelve con el módulo de notificaciones/handlers de eventos.
2. **Deshacer una fusión:** no existe (queda el cliente archivado con `merged_into_id`, pero sin botón). Es irreversible en la UI, y se avisa antes de confirmar.
3. **Búsqueda global y paleta de comandos** (§13.4): aún pendientes; la búsqueda actual es por lista.
4. ~~Estado de los leads de solo lectura~~ → **resuelto en la Fase 3** (máquina de estados con log, §15).
5. **Consentimiento por canal** (más allá de «no contactar» y el campo `consent` del lead): llega con Omnicanal (Fase 5).
6. **Webhooks genéricos y formularios embebibles** (CORS + captcha): hoy la API es servidor a servidor con llave. Meta/WhatsApp llegan en la Fase 5.
7. **Exportación** de clientes/leads: cuando se agregue, hay que neutralizar celdas que empiecen por `= + - @` (inyección de fórmulas en Excel). Hoy solo se **importan** y se muestran como texto.
8. **Similitud de nombres** más fina (trigram) si el volumen de falsos negativos lo justifica; hoy es coincidencia exacta normalizada.
9. La deuda de §13 (correo de invitaciones, rate limiting en el borde, CSP estricta, configuración de la organización, roles personalizados, rotación de `service_role`) sigue vigente.

## 15. Fase 3 — pipelines, oportunidades, tareas y actividades

**Decisiones**
- **Pipelines y etapas configurables** por organización. Cada etapa tiene un *tipo* inmutable: `open` (0–99 %), `won` (100 %) o `lost` (0 %); la probabilidad de las abiertas alimenta el valor ponderado del embudo. Cada pipeline conserva al menos una etapa de cada tipo. Toda organización nace con un pipeline «Ventas» predeterminado (Nuevo → Contactado → Propuesta → Negociación → Ganada / Perdida) y las existentes lo reciben en la migración. Un pipeline nuevo se crea **solo por RPC** (`create_pipeline`) para que nunca exista sin etapas. Límites: 10 pipelines y 25 etapas activas.
- **Una oportunidad es siempre de un cliente y hereda su propietario y equipo** (fuente única de verdad, §12). Nunca es visible para quien no ve al cliente. Si el cliente se reasigna, sus oportunidades **abiertas** lo siguen; las cerradas conservan su propietario. Sin propietario (cliente entrado por API/CSV) → solo la ve un manager, hasta que se asigne.
- **Log de transiciones (`state_transitions`)**: toda transición de un lead o de una oportunidad queda registrada **por un trigger** (quién, cuándo, de qué a qué, motivo, vía user/system/api/automation, y tipos de etapa para el análisis de embudo). Es *append-only* (ni UPDATE, ni DELETE, ni TRUNCATE) y se ve con el mismo alcance que el registro al que pertenece. Los estados **no son escribibles directamente**: solo por RPC (`move_opportunity`, `set_lead_status`, `convert_lead`, `create_opportunity`).
- **Reglas de cierre:** perder exige motivo (≥ 3 letras); una oportunidad cerrada solo la reabre o edita un manager/admin; una nueva debe empezar en etapa abierta; no se mueve a etapas archivadas ni de otro pipeline.
- **Máquina de estados de leads** (nuevo → contactado → calificado → convertido / descartado): descartar exige motivo; reactivar limpia el motivo; **«convertido» solo se alcanza con `convert_lead`**, que crea la oportunidad y pasa por «calificado» dejando ambos pasos en el log. La BD es la autoridad; `src/lib/leads.ts` es un espejo solo para decidir qué opciones mostrar, **y una prueba de integración compara las 20 combinaciones origen→destino con la BD**.
- **Tareas** (algo por hacer: responsable, vencimiento, prioridad) **y actividades** (algo que ya pasó: llamada, reunión, nota; **inmutables**, un error se corrige con otra nota). Crear cualquiera exige acceso al cliente/oportunidad al que se vincula. Una tarea de una oportunidad hereda su cliente. Asignar a otra persona: vendedor no; sales manager dentro de su equipo; manager/admin a cualquiera. Las tareas abiertas **del responsable anterior** siguen al cliente al reasignarlo o fusionarlo; las asignadas a mano a otra persona no se tocan. Las horas se interpretan y agrupan (vencidas/hoy/mañana…) en **la zona horaria de la organización**, no en la del servidor.
- **Fusión de clientes ahora usa un registro** (`app.customer_merge_targets`): toda tabla nueva con `customer_id` debe registrarse (una prueba estructural lo exige) y la fusión mueve oportunidades, tareas y actividades. Los eventos se enlazan al cliente para la línea de tiempo.
- **Matriz de permisos:** `marketing`, `customer_service`, `analyst` y `viewer` pasan de alcance `org` a `own` sobre `opportunities`, `quotes`, `sales`, `conversations`, `tasks` y `cases`. Sin este ajuste verían título, monto y cliente de oportunidades de clientes que la regla de §12 les oculta. Una prueba lo fija; es reversible (solo cambia datos de la matriz). Si un rol necesita verlas todas, se le otorga `org` de forma explícita.
- **Campos personalizados** también para oportunidades.

**Correcciones de seguridad y consistencia halladas en esta fase**
- **`can_access_row` devolvía `NULL` para registros sin propietario**, y el patrón `if not found or not app.can_access_row(...) then raise` dejaba pasar el `NULL`: un vendedor podía operar por RPC sobre registros sin dueño (p. ej. agregar un identificador a un cliente sin asignar en la Fase 2, si conocía su UUID). Ahora **nunca devuelve NULL**; hay pruebas de regresión en clientes, oportunidades, tareas y actividades.
- **`now()` es constante dentro de una transacción:** eventos del mismo request («cliente creado» y «lead recibido», las dos transiciones de `convert_lead`) empataban y se mostraban en orden aleatorio. `domain_events`, `audit_logs` y `state_transitions` usan ahora `clock_timestamp()`.
- Una **prueba estructural de fusión** dejó de comparar contra una lista fija y compara contra el registro.

**Verificado**
- **SQL (PostgreSQL 16):** 479 aserciones en 8 suites (Fase 3: pipelines 38, oportunidades y leads 80, tareas y actividades 73).
- **Concurrencia real:** 40 personas moviendo **la misma oportunidad** a la vez dejan un historial que es una cadena íntegra y coincide con la etapa actual; 12 completando **la misma tarea** → un solo «completada». Se suman a los 3 escenarios de la Fase 2.
- **Mutaciones:** 19 vulnerabilidades inyectadas en SQL (reabrir cerradas, perder sin motivo, log modificable, `NULL` en accesos, visibilidad total, matriz de permisos, herencia de propietario, seguimiento de tareas, fusión que olvida tablas, actividades editables, tareas a clientes ajenos, orden cronológico, bloqueo de tareas…) y 5 en TypeScript (zona horaria, montos, motivo de descarte, máquina de estados). **17 y 5 detectadas; 2 son *equivalentes* (no observables):** el trigger que impide reasignar tareas queda cubierto por RLS, y el `FOR UPDATE` explícito de `move_opportunity` es redundante con el bloqueo del propio `UPDATE`. Varias pruebas propias resultaron incorrectas al ejecutarlas y se corrigieron (una pasaba por azar el 50 % de las veces: ahora es determinista). Un primer intento de mutación dio falsos negativos por un fallo del arnés (PostgreSQL caído); se corrigió el arnés para distinguir «no detectada» de «infraestructura».
- **Integración contra PostgREST real:** 34 pruebas (17 de la Fase 2 + 17 de la Fase 3) con repositorios, servicios y JWT reales.
- **Unitarias:** 119 (montos, zonas horarias, vencimientos, embudo, máquina de estados, servicios, línea de tiempo, errores). `tsc` limpio, `next build` correcto.
- **Trazabilidad:** la migración `0009` apareció en el proyecto sin haber sido escrita en esta sesión. Se revisó línea por línea, se le añadieron tres correcciones (anti-`TRUNCATE`, creación atómica de pipelines, endurecimiento de accesos) y se sometió a las pruebas y mutaciones anteriores.

**NO verificado todavía**
- Nada se ha ejecutado contra un **proyecto Supabase real** (ver `docs/DEPLOY.md`). Las pantallas nunca se han abierto en un navegador: el tablero, los formularios con `<details>` y el orden de etapas necesitan revisión visual y de accesibilidad. No hay pruebas end-to-end.
- El **tablero** carga hasta 500 oportunidades abiertas por pipeline sin paginar; no hay arrastrar y soltar (se mueve con un formulario).
- Las **automatizaciones** que respeten «no contactar» aún no existen (Fases 7–8): hoy solo se **avisa** al crear tareas de contacto para un cliente que pidió no ser contactado (no se bloquea).

**Deuda conocida (priorizada)**
1. **Cotizaciones, productos y ventas (Fase 4):** «ganada» hoy solo cierra la oportunidad; no crea la venta ni abre el postventa.
2. **Notificaciones** de tareas vencidas (hoy solo se ven en «Hoy» y en Tareas).
3. **Asignación de leads sin dueño** de forma automática (Fase 6); hoy un manager los reparte a mano.
4. **Analítica del embudo:** los datos (`state_transitions.meta`) ya están; los reportes llegan en la Fase 10.
5. Tareas recurrentes, subtareas y recordatorios: fuera de alcance por ahora.
6. Pipelines: el orden de etapas se cambia con ↑/↓; falta reordenar por arrastre y una vista de pipeline por equipo.

---

## 16. Fase 4 — catálogo, cotizaciones, ventas y postventa

**Qué se construyó** (migraciones `0011` y `0012`; 29 tablas, todas con RLS)
- **Catálogo:** tabla única `products` con `kind` (producto/servicio), SKU único sin distinguir mayúsculas, precio, IVA, activo/inactivo. El tipo es inmutable; no se borra, se desactiva.
- **Cotizaciones** (`quotes` + `quote_items`): numeración correlativa por organización (`COT-0001`) con un contador atómico; **el dinero se calcula solo en la base de datos** (`numeric`, redondeo por línea a 2 decimales; nadie puede escribir totales); cada línea guarda una **foto** del producto (nombre, precio, IVA); una cotización **enviada es inmutable** (cambiar = nueva versión, la anterior queda «reemplazada»); una sola aceptada por oportunidad; vigencia (no se acepta vencida); **descuentos sobre el límite de la organización** (`settings.quote_discount_limit_pct`, 10 % por defecto) solo los envía un manager/admin.
- **Ventas** (`sales` + `sale_items`): nacen solo de una cotización **aceptada** con una copia inmutable (líneas y totales); registrarla cierra la oportunidad como **ganada** por el valor neto (sin IVA) y abre **3 tareas de seguimiento** (confirmar entrega +3 días, satisfacción +10, recompra +60) para el responsable del cliente (sin asignar si no tiene dueño; avisa si pidió no ser contactado). Una cotización tiene como máximo una venta activa. Anular exige manager/admin y un motivo, y cancela el seguimiento pendiente.
- **Casos** (`cases`): soporte, reclamo, garantía, devolución, pregunta; estados abierto → en curso → resuelto → cerrado; resolver exige la solución; reabrir un cerrado exige manager.
- **Historial:** `state_transitions` ahora cubre cotizaciones, ventas y casos con un trigger genérico (`app.log_status_change`). Todo movimiento de estado pasa por RPC; ningún estado ni monto es escribible directamente.
- **Interfaz:** Productos y servicios, Cotizaciones (detalle con edición de líneas en borrador y vista imprimible), Ventas, Casos de postventa; secciones nuevas en la oportunidad y en el cliente; la línea de tiempo del cliente narra todo lo anterior.

**Decisiones**
- **Quién registra una venta:** hoy la matriz de permisos de la Fase 1 da `sales:create` solo a manager, admin y sales manager; **un vendedor no puede registrar ventas** (sí cotizar y marcar la aceptación). Es una decisión de negocio, no un accidente: una prueba la fija para que cambiarla sea deliberado. Para permitirlo a los vendedores basta agregar `sales:create` y `sales:update` con alcance `own` a `sales_agent` (un `INSERT` en `role_permissions`; `create_sale` ya respeta el alcance).
- El valor de la oportunidad ganada es el **neto sin impuestos** (subtotal − descuentos).
- Una venta anulada **no reabre** la oportunidad (queda ganada; un manager puede reabrirla) y permite volver a vender la misma cotización.
- Las cotizaciones abiertas (borrador y enviadas) **siguen al cliente** cuando se reasigna, como leads, oportunidades y tareas; las aceptadas y las ventas conservan su propietario.
- Los casos se asignan por defecto a **quien los abre**, no al dueño comercial del cliente (así servicio al cliente ve lo que abre con su alcance `own`).

**Verificado**
- **SQL:** 143 aserciones nuevas (cotizaciones 76, ventas/postventa/casos 67), incluidas regresiones de `NULL` en accesos sobre oportunidades sin dueño.
- **Concurrencia real:** 40 cotizaciones creadas a la vez → 40 números distintos, del 1 al 40, sin huecos; 10 personas registrando **la misma venta** a la vez → una sola venta y un solo juego de 3 tareas.
- **Mutaciones SQL:** 18 defectos inyectados (numeración que no incrementa, descuentos sin aprobación, IVA sobre bruto, líneas editables tras enviar, dos cotizaciones aceptadas, aceptar vencida, versión sin copiar líneas, RLS abierta en cotizaciones/productos/casos, venta sin cotización aceptada, total de venta modificable, líneas de venta editables, anulación por sales manager, seguimiento sin asignar o sin cancelar, oportunidad sin cerrar, reapertura sin permiso). **Las 18 detectadas.** Se descartaron dos candidatas por ser *equivalentes* (el índice único y la comprobación explícita cubren lo mismo; el `CHECK` de la solución cubre la validación del texto).
- **Integración contra PostgREST real:** 13 pruebas nuevas (47 en total) con los mismos repositorios y servicios de la app y JWT reales.
- **Unitarias:** 130 (`parsePercent`, `parseQuantity`, servicios de comercio, línea de tiempo, errores en español). `tsc` limpio; `next build` correcto con las 6 rutas nuevas.
- **Instaladores:** `setup-all.sql` en una base vacía y `setup-desde-0011.sql` sobre una base con 0001–0010 dan `LISTO` (29 tablas, 29 con RLS); el incremental se niega a ejecutarse dos veces o sin la Fase 3.
- **Errores propios corregidos al ejecutar:** una restricción que habría rechazado «rechazada → reemplazada», un bloqueo de líneas que habría impedido borrar una organización con cotizaciones enviadas, una aserción vacía (comparaba `NULL` con `NULL`) y varias expectativas de prueba mal calculadas.
- **Trazabilidad:** el resumen de la sesión anterior describía trabajo de Fase 4 que **no estaba en el directorio del proyecto**; se reconstruyó y se verificó de nuevo desde cero.

**NO verificado todavía**
- Nada de la Fase 4 se ha ejecutado contra el **proyecto Supabase real** de despliegue ni se ha abierto en un navegador (no hay navegador en el entorno de desarrollo): los formularios con `<details>`, la vista de impresión y el detalle de cotización necesitan revisión visual y de accesibilidad. No hay pruebas end-to-end.
- No hay **PDF generado en servidor**: se imprime desde el navegador. Tampoco hay envío de la cotización por correo/WhatsApp (llega con el Inbox, Fase 5).

**Deuda conocida (priorizada)**
1. Pagos y facturación (la venta no registra cobros ni emite factura).
2. Envío de cotizaciones por canal y firma/aceptación por el propio cliente (hoy la marca quien vende).
3. Listas de precios, monedas por producto, inventario, paquetes y descuentos por volumen.
4. Vencimiento **automático** de cotizaciones (hoy se calcula al mostrar y se exige al aceptar).
5. Casos: SLA, asignación automática, comentarios y adjuntos.
6. Reportes de ventas y postventa (Fase 10).

## 17. Fase 5 — Inbox y WhatsApp (API de Meta)

**Qué se construyó** (migración `0013`; 35 tablas, todas con RLS)
- **Flujo de entrada:** webhook → **firma verificada** (HMAC-SHA256 del cuerpo *crudo* con el App Secret, en tiempo constante; sin secreto configurado se rechaza todo) → `raw_events` (**se guarda antes de procesar**) → normalización (`src/lib/meta.ts`, puro y tolerante a payloads malformados) → `ingest_whatsapp_message` → conversación → mensaje. Si algo falla al procesar, el evento queda pendiente y un barrido lo reintenta (máx. 8 veces; los procesados se purgan a los 30 días). Si ni siquiera se pudo guardar, la ruta responde 500 para que Meta reintente.
- **Identidad:** un contacto desconocido nace como **cliente + lead** (origen `whatsapp`) reutilizando `resolve_customer`/`ingest_lead_core` de la Fase 2 (mismos bloqueos y detección de duplicados); uno conocido se enlaza por su teléfono (`+` + `wa_id`). La conversación **sigue al dueño del cliente** cuando se reasigna (abiertas y cerradas) y se mueve en las fusiones de clientes.
- **Deduplicación:** índice único `(canal, id externo)` más un bloqueo por conversación: el mismo mensaje entregado 15 veces a la vez se registra una vez; 15 primeros mensajes simultáneos de un contacto nuevo dan 1 cliente, 1 lead, 1 conversación y 15 mensajes.
- **Salida:** `queue_message` / `queue_template_message` validan en la base de datos permiso (alcance de la conversación), canal activo, **ventana de 24 h**, «no contactar» y, en plantillas, aprobación y número exacto de datos. Luego el servidor **reclama** el mensaje de forma atómica (`queued → sending`) y lo envía.
- **«Como máximo una vez»:** un rechazo definitivo de Meta (4xx) marca «falló» con el motivo en español. Un resultado **desconocido** (red, tiempo agotado, 5xx) **no se reenvía**: el barrido lo marca «falló: verifica en WhatsApp» a los 5 minutos. Solo se reenvían mensajes que nunca llegaron a reclamarse.
- **Estados de entrega:** solo avanzan (enviado → entregado → leído); uno atrasado se ignora; un «falló» tardío no pisa un mensaje ya leído. Si el estado llega **antes** de que guardemos el id del envío (carrera real), queda pendiente y el barrido lo aplica.
- **Secretos:** el token de acceso vive en `channel_secrets`, **sin ninguna política ni permiso para usuarios** (ni admin); solo `channel_credentials` (llave de servicio) lo lee. El administrador solo puede saber *si* hay token. Ningún evento, auditoría ni texto de error lo contiene.
- **Solo-anexar:** los mensajes no se editan ni se borran (salvo al eliminar la organización).
- **Interfaz:** Inbox (Sin responder / Abiertas / Sin asignar / Cerradas, refresco cada 15 s), conversación (burbujas, estado de cada envío, ventana visible, plantillas), Configuración → Canales (URL del webhook, estado de los secretos, plantillas), conversaciones en la ficha del cliente y en su línea de tiempo.

**Decisiones**
- **«No contactar»:** bloquea plantillas y todo envío proactivo (fuera de ventana), pero **permite responder** dentro de las 24 h a un cliente que acaba de escribir. Es una sola condición en `app.queue_outbound`, fácil de endurecer si tu asesoría legal lo pide.
- **Baja automática:** un mensaje que sea *exactamente* «stop», «baja», «parar», «no molestar», «no más», «cancelar suscripción», «darme de baja» o «unsubscribe» (sin distinguir mayúsculas, tildes ni signos) marca al cliente «no contactar». Una frase que solo *contiene* esas palabras no cuenta.
- **Visibilidad:** la de la Fase 1 (§12): vendedor solo lo suyo, sales manager su equipo, manager/admin todo. Las conversaciones de clientes sin dueño solo las ven quienes tienen alcance de organización («Sin asignar»); se asignan reasignando al cliente.
- **Hora de Meta:** llega redondeada a segundos y con su reloj. Solo se considera «atrasado» un mensaje con más de 2 minutos de diferencia; una respuesta rápida del cliente **no** puede tratarse como anterior a nuestro envío (defecto real encontrado y corregido con una prueba de regresión).
- **Credenciales:** `META_APP_SECRET` y `META_VERIFY_TOKEN` son variables de entorno (una app de Meta para toda la instalación); el token de acceso es **por canal**.
- **Plantillas:** se copian a mano desde las ya aprobadas en Meta (nombre, idioma y texto exactos); el sistema valida los marcadores `{{1}}…` y el número de datos. No hay sincronización automática ni envío de plantillas para aprobación.
- **Alcance:** solo **WhatsApp** (el modelo admite otros canales; Instagram y correo quedan para más adelante).

**Verificado**
- **SQL:** 114 aserciones nuevas en `inbox.test.sql` (secretos, plantillas, identidad, duplicados, visibilidad por rol, ventana, «no contactar», bajas, estados, barrido, cola de webhooks, solo-anexar, fusión, RLS, permisos de funciones).
- **Concurrencia real:** 3 escenarios nuevos (mismo mensaje ×15, primeros mensajes de un contacto nuevo ×15, 12 reclamos del mismo envío → exactamente 1).
- **Mutaciones:** **44 defectos inyectados** (32 SQL + 12 TypeScript) —ventana ampliada, «no contactar» ignorado, estados que retroceden, reclamo no atómico, tokens legibles, RLS abierta, mensajes editables/borrables, baja no aplicada o demasiado amplia, sin tolerancia de reloj, firma sin comparar, handshake sin token, 5xx tratado como definitivo, desconocido tratado como fallo, ruta sin firma, `null` → 500…—. **Las 44 detectadas.**
- **Integración contra PostgREST real:** 24 pruebas nuevas (71 en total): la **ruta real** del webhook (firma, 401/413/400/503, reintentos idénticos, payloads raros), los mismos repositorios y servicios de la app con JWT reales, y el envío hacia un **servidor Meta simulado** que comprueba URL, cabecera `Bearer` y cuerpo exactos, 8 entregas simultáneas del mismo mensaje (una sola llega), rechazo 131047, Meta caído (sin reenvío), barrido, carrera de estados y que el token no aparece en ninguna tabla.
- **Unitarias:** 178 en total (firma, handshake, lectura de todos los tipos de mensaje, fuzz determinista de 500 estructuras aleatorias, envío, entrega, procesamiento, servicios, errores en español).
- **Instaladores:** `setup-all.sql`, `setup-desde-0011.sql` y `setup-desde-0013.sql` dan el mismo esquema (35 tablas con RLS, 117 funciones); los incrementales se niegan a ejecutarse dos veces o sin la Fase 4.
- **Errores propios corregidos al ejecutar:** el orden por hora del proveedor (arriba), un `null` firmado que producía 500, un filtro de tokens que faltaba en los textos de error, `now()` en vez de `clock_timestamp()` dentro de la cola de webhooks, una prueba que comparaba conteos mal calculados y una colisión de datos entre archivos de prueba.
- **Defecto encontrado en la primera prueba real (y corregido):** el filtro de sesión (`middleware`) no incluía `/api/webhooks` entre las rutas que se autentican solas, así que Meta —que no tiene sesión— recibía una redirección al login y ni el saludo ni ningún mensaje llegaba. Las pruebas de integración llamaban al código de la ruta directamente y se saltaban ese filtro. Ahora `/api/webhooks` se trata como la API de leads (se autentica con la firma), hay una prueba de regresión (`middleware.test.ts`) y se verificó contra la **app compilada y en ejecución** (`next start`) sin sesión: saludo 200, token equivocado 403, mensaje sin firma 401, páginas privadas siguen redirigiendo. Lección: las pruebas de rutas públicas deben pasar por el `middleware`, no solo por el manejador. También se recortan espacios/saltos de línea invisibles de `META_APP_SECRET` y `META_VERIFY_TOKEN` (un fallo típico al pegar valores en Vercel).
- **Trazabilidad:** el resumen de la sesión anterior daba el código de la Fase 5 por terminado, pero **no estaba en el directorio**; se reconstruyó y se verificó desde cero.

**NO verificado todavía**
- **Nada se ha probado contra Meta real.** El formato de las peticiones se contrastó con la documentación pública y con un servidor simulado, no con la API. Los códigos de error traducidos y la versión por defecto de la API (`v24.0`, configurable con `META_GRAPH_VERSION`) hay que confirmarlos en la primera prueba real.
- Ni la Fase 5 ni la 4 se han ejecutado contra el **Supabase real**, ni abierto en un navegador (no hay navegador en el entorno): el aspecto de las burbujas, el refresco automático y los formularios desplegables necesitan revisión visual.

**Deuda conocida (priorizada)**
1. **Adjuntos:** los mensajes con imagen/audio/documento quedan como etiqueta + referencia (`media_id`); no se descargan ni se pueden ver ni enviar.
2. **Tiempo real:** hoy es un refresco cada 10–15 s; Supabase Realtime lo haría instantáneo. Tampoco hay contador de «sin leer» en el menú.
3. **Teléfonos con prefijos variables** (p. ej. México/Brasil, donde `wa_id` puede diferir del número guardado) pueden crear un cliente duplicado; el flujo de revisión de duplicados de la Fase 2 lo cubre parcialmente.
4. **Alertas** cuando el token vence o el canal falla (hoy solo se ve al intentar enviar).
5. Instagram/Messenger y correo; clasificación de intención (Fase 9); asignación automática y SLA de respuesta (Fase 6); respuestas rápidas y notas internas en la conversación.
6. El token se guarda en la base de datos protegido por permisos (nadie con sesión lo lee) y por el cifrado en reposo de Supabase; no hay cifrado adicional a nivel de aplicación ni *vault*.

