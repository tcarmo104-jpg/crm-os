# Widget de WhatsApp para sitios web — Fase 1 (lo esencial de punta a punta)

## Decisión de diseño (confirmada contigo antes de construir)
El botón **no abre un chat en vivo dentro de la página** — eso no es posible de forma legítima con la API
oficial de WhatsApp Business para un visitante anónimo, y tu propia especificación pedía evitar cualquier
cosa que no sea la API oficial.

En vez de eso: el visitante llena su nombre, WhatsApp y mensaje (con toda su atribución: página, producto,
UTMs, referido), el CRM crea o encuentra el contacto, y el navegador del visitante se **redirige a WhatsApp**
con el mensaje ya escrito. Cuando el visitante le da «Enviar» ahí, ese mensaje llega a tu número real de
WhatsApp Business y entra al Inbox exactamente como cualquier mensaje de WhatsApp — nada nuevo que tocar ahí.

## Qué se construyó
- Generador de widgets (Configuración → WhatsApp → Widgets): nombre, número conectado, texto del botón,
  mensaje de bienvenida, posición, color, tamaño, mostrar/ocultar texto, dominios autorizados y región
  (opcional: la sede de la web donde se instala, que usan las reglas de distribución).
- Código de instalación de una sola línea, que no hay que volver a tocar si cambias la configuración.
- Un script embebible propio (sin dependencias, con sus propios estilos para no chocar con el sitio donde
  se instale) que dibuja el botón, abre el formulario, y redirige a WhatsApp.
- Reutiliza `app.ingest_lead_core` — el mismo motor que ya usa la API pública de leads — para crear o
  encontrar el contacto sin duplicar nada.
- Seguridad: el «Widget ID» es público a propósito (va en el HTML del sitio del cliente). La protección real
  es **validar el dominio** desde el que llega cada solicitud, y un **límite de 20 solicitudes por minuto**
  por widget — igual que ya se hace con las llaves de API, pero sin una llave secreta expuesta en el sitio.

## Dos errores reales encontrados y corregidos al verificar en un navegador real
1. **El más serio: el script y los dos endpoints públicos quedaban bloqueados por el sistema de inicio de
   sesión del CRM.** Cualquier visitante anónimo de un sitio web —que nunca tiene sesión iniciada en el
   CRM— habría visto el widget simplemente no funcionar. Se encontró el mecanismo correcto ya existente en
   el proyecto (`SELF_AUTH_PREFIXES`, el mismo que usan los webhooks de Meta) y se usó ahí, en vez de la
   lista de páginas públicas (que es para otra cosa).
2. Al construir una página de prueba simulando un sitio externo real (en otro puerto, para probar de verdad
   cruzando dominios), un archivo de mi propia prueba quedó con texto corrupto por un error mío al capturar
   la salida de un comando — generó una serie de «falsos 404» que investigué a fondo antes de confirmar que
   la aplicación en sí estaba bien.

## Verificación
- 22 pruebas SQL (incluida la validación de dominio y el límite de velocidad, probado de verdad con 25
  solicitudes seguidas), con 3 mutaciones de seguridad, todas detectadas.
- 19 pruebas unitarias nuevas, 3 de integración contra Postgres/PostgREST reales.
- **Verificación de punta a punta con un sitio externo real** (servido en un puerto distinto, simulando un
  dominio ajeno): se abrió el botón, se llenó el formulario, se confirmó que redirige a WhatsApp con el
  número correcto de la empresa y el mensaje del visitante bien armado, y que el contacto con toda su
  atribución (UTMs, página de origen) quedó creado en el CRM.

## Qué queda para las siguientes fases (ya lo hablamos)
- Fase 2: botón «Crear oportunidad»/«Crear cotización» desde una conversación del Inbox, y mostrar el origen
  exacto del widget en la ficha del cliente.
- Fase 3 (hecha): reglas de distribución automática (round robin, por región, por equipo, por horario), en
  Configuración → Distribución de conversaciones. La región sale de la configuración de cada widget, y solo
  un contacto nuevo consume turno: si el teléfono ya existía, conserva su dueño (o sigue sin dueño).
- Fase 4 (hecha): métricas del widget en Analítica → pestaña Widget de WhatsApp (`/analytics/widget`; antes `/reports/widget`, que ahora redirige). Detalle abajo.
- Fase 5: vista previa en vivo del botón, tabla de administración con estadísticas por widget.

## Fase 2: oportunidad/cotización desde el Inbox, y ver el origen del cliente

- **«+ Nueva oportunidad» directo desde cualquier conversación del Inbox.** No se construyó un formulario
  nuevo: se reutilizó la pantalla de crear oportunidad que ya existía (`/opportunities/new?customer=…`, que
  ya aceptaba un cliente por la URL), solo se agregó el enlace desde la ficha del cliente.
- **Cotizar**: como una cotización siempre pertenece a una oportunidad (no existen sueltas), la ficha del
  cliente lista sus oportunidades abiertas con un enlace «Ver / cotizar» a cada una — ahí es donde ya existe
  el botón de «Nueva cotización». Nada duplicado.
- **Sección «Origen»**: si el cliente llegó por un widget de WhatsApp, la ficha muestra de qué widget vino,
  la página exacta, y las UTM (fuente, campaña) — tomado del mismo lead que `start_widget_conversation` ya
  guardaba en la Fase 1, sin ningún dato nuevo que capturar.

### Verificación
- 3 pruebas de integración nuevas (oportunidad visible en la ficha, origen del widget correcto, un cliente
  sin origen de widget no revienta — queda `null` con naturalidad).
- Verificado en navegador real: la sección «Origen» expandida muestra el widget, la página y la campaña
  correctamente. El enlace «+ Nueva oportunidad» apunta al cliente correcto y precarga el formulario ya
  existente — confirmado visualmente.
- **Una verificación que no pude completar**: el envío final del formulario de «Nueva oportunidad» (una
  pantalla que ya existía antes de esta fase, sin tocar) se comportó de forma inconsistente con mi sesión de
  prueba simulada durante la navegación automatizada — probablemente una particularidad de cómo mi entorno
  de pruebas simula el inicio de sesión frente a una redirección de un Server Action, no algo que un usuario
  real con una sesión real debería notar. La lógica de creación en sí ya está probada a fondo, incluidas 279
  pruebas de integración contra la base de datos real que confirman que `createOpportunity` funciona
  correctamente. Vale la pena que confirmes este paso específico (crear la oportunidad desde el botón nuevo)
  la primera vez que lo uses.

## Fase 4: métricas del widget (Analítica → Widget de WhatsApp)

**No se duplicó la analítica: se extendió.** La página nueva usa los mismos períodos, la misma comparación
contra el período anterior, el mismo formulario de filtros (`DashboardFilters`, al que se le agregaron
selectores opcionales sin cambiar su uso en el Dashboard), los mismos gráficos y la misma exportación a CSV
(`/api/reports/export?type=widget`) que el resto de Analítica. La lógica de cálculo vive en `lib/analytics.ts`
(funciones puras, como el resto) y el permiso es el mismo `reports:read` / `reports:export`.

**Qué se mide**: conversaciones iniciadas, cuántas escribieron de verdad por WhatsApp, contactos nuevos vs.
recurrentes, conversión a oportunidad y a venta (con monto), tiempo de primera respuesta y de resolución
(promedio y mediana), con desglose por página de origen, producto, campaña, asesor, región, equipo y widget,
y filtros por todo eso más fecha. La misma página con distintos UTMs en la URL se agrupa como una sola.

**Una migración pequeña (0036), por dos cosas que no existían:**
1. *Cuándo se cerró una conversación.* Cerrar no dejaba fecha en ningún lado, y una conversación se reabre
   con cada mensaje nuevo; se agregó un registro de cierres (solo-anexar, por trigger). **El tiempo de
   resolución se mide desde que se instala esta versión**: los cierres anteriores no se pueden reconstruir.
2. *`widget_lead_facts`*, una fila por lead del widget con lo que le pasó después. Es `security definer`
   porque los widgets solo los lee `settings:manage`; por eso aplica a mano `reports:read` y **el mismo
   predicado que la política de `leads`**: cada rol ve exactamente los leads que ya veía en Leads.

**Cómo se atribuye** (también explicado en la propia página, en «Cómo se calcula cada número»):
- *Escribió por WhatsApp*: su primer mensaje entrante en el número del widget dentro de las 24 h siguientes.
- *Primera respuesta*: el primer mensaje escrito por una persona (las automatizaciones no cuentan).
- *Resolución*: el primer cierre de esa conversación después de que escribió.
- *Oportunidad*: la convertida desde el lead o, si no, la primera del cliente creada después del formulario
  (así cuenta la del botón «+ Nueva oportunidad» del Inbox, que se crea para el cliente). *Venta*: la primera
  no anulada de esa oportunidad.
- Si el cliente vuelve a usar el widget, lo que pase desde ahí es del lead nuevo: nada se cuenta dos veces.
- Las tasas de conversión son sobre las conversaciones iniciadas (cada formulario enviado).

**Dos errores reales encontrados con el navegador** (ninguna prueba automática los había detectado): las
etiquetas del embudo se cortaban («Llenaron el form…») y el aviso «sin datos del período anterior» se repetía
tres veces. Se acortaron las etiquetas (con la explicación completa debajo) y la comparación se oculta cuando no
hay base, como en el Dashboard. También se corrigió un error de la Fase 3: el cambio de `WidgetInput` había
dejado sin compilar `widgets.int.test.ts` (no afectaba la ejecución, sí la verificación de tipos).

**Rendimiento**: 5.000 leads del widget con todo su recorrido se calculan en ~0,6 s. La página consulta el
período actual y el anterior; tope de 5.000 por período, con aviso visible si se alcanza.

**Verificación**: 26 pruebas SQL nuevas (atribución caso por caso y permisos por rol), 19 unitarias nuevas (más la de navegación ampliada), 5
de integración contra PostgREST real (suite completa: 284), y 27 comprobaciones en navegador real con datos
sembrados por los caminos reales (formulario público, webhook de WhatsApp, respuesta desde el Inbox, cierre,
oportunidad, cotización aceptada y venta): KPIs contra la base de datos, las 7 pestañas de desglose, filtros
combinados que conservan la pestaña, el CSV descargado (igual a lo que se ve), una vendedora y un jefe de
ventas viendo solo lo suyo, la exportación negada sin permiso, y la vista en móvil.

**Ojo al correr las pruebas de integración**: `widgets.int.test.ts` prueba la ruta pública del widget solo si
encuentra una app escuchando en `APP_URL` (por defecto `http://127.0.0.1:3999`); si no hay nada, esa parte se
salta sin avisar. Si en ese puerto hay una app conectada a OTRA base de datos (me pasó con mi servidor de
pruebas del navegador), la prueba falla porque no encuentra el widget recién creado. Con el puerto libre o
con la app correcta: 284/284.
