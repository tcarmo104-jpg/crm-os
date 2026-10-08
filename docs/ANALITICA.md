# Dashboard, Reportes, Embudo y Desempeño — qué se construyó (Fase 10)

## Diagnóstico
El dashboard «Hoy» ya mostraba algunos indicadores, pero es una vista **personal** («lo mío»). Faltaba una
vista de **toda la organización** (o del equipo, según el rol), un embudo con conversión entre etapas,
reportes exportables, y una tabla de desempeño por persona.

**Sin migración nueva**: todo se calcula con datos que ya existen (oportunidades, ventas, tareas, leads).
Los permisos `reports:read` / `reports:export` ya estaban definidos y asignados por rol desde la Fase 1
(cada rol ve tanto como sus propios datos ya le dejan ver — no se creó una capa de permisos nueva).

## Qué se construyó
- **`lib/analytics.ts`**: períodos con nombre (hoy, últimos 7/30 días, este mes, este año, personalizado),
  embudo con conversión entre etapas, ventas agrupadas por mes, leads agrupados por fuente, desempeño por
  persona. Lógica pura, sin tocar la base de datos.
- **`/dashboard`**: la foto general — pipeline abierto, ingresos del período, tasa de conversión, leads, y
  un embudo resumido del pipeline principal.
- **`/funnel`**: el embudo completo, con monto y conversión real entre cada etapa y la siguiente.
- **`/performance`**: una fila por persona, con ganadas/perdidas, monto ganado, conversión y tareas
  completadas, exportable a CSV.
- **`/reports`**: ventas por período y leads por fuente, cada uno exportable a CSV.
- Exportación vía `/api/reports/export` (una ruta que responde CSV descargable con un enlace normal, sin
  necesitar JavaScript).
- Se extendieron `listOpportunities`, `listSales`, `listTasks` y `listLeads` con filtros de fecha,
  respetando su uso existente.
- Menú actualizado: estas 4 páginas salieron de «Próximamente» a un grupo nuevo, «Analítica».
- **Ampliación (Widget de WhatsApp, Fase 4)**: `/reports/widget`, métricas del widget con los mismos períodos,
  filtros, gráficos y exportación. Ver `docs/WIDGET-WHATSAPP.md` → «Fase 4».

## Dos errores reales encontrados y corregidos
1. **Un error serio, cometido y corregido en el camino:** al crear `lib/csv.ts` sobreescribí sin darme
   cuenta un archivo que ya existía (usado para importar leads desde CSV), en vez de revisar primero si el
   archivo ya existía. Se detectó de inmediato porque rompió la compilación; se recuperó el archivo original
   completo desde una copia limpia y se le agregó la función nueva sin tocar lo que ya tenía. Se confirmó con
   la suite completa que no quedó ningún daño.
2. **Un error real en la pantalla de Embudo**, encontrado con datos de prueba reales: la página decidía si
   mostrar «no hay oportunidades» mirando solo el conteo de la **primera** etapa, en vez de sumar todas. Con
   oportunidades solo en etapas intermedias, mostraba el mensaje de vacío estando mal. Corregido sumando
   todas las etapas. De paso se ajustó una etiqueta («Primera etapa») que aparecía también en etapas que no
   lo eran, cuando la etapa anterior simplemente no tenía oportunidades.

## Verificación
- 479 pruebas unitarias (16 nuevas de esta fase), y 265 de integración contra Postgres/PostgREST reales
  (incluyendo que los filtros de fecha nuevos funcionan y que cada rol solo ve lo que ya podía ver).
- 15 comprobaciones en navegador real con datos sembrados de verdad: oportunidades en varias etapas,
  ganadas, perdidas, una venta real (cotización → aceptada → venta → entregada), y leads de varias fuentes.
  Se confirmó que el botón «Exportar CSV» realmente descarga un archivo válido.

## Una sola pantalla con pestañas (`/analytics`)

**Qué cambió para quien la usa.** Las 5 páginas de Analítica (Dashboard, Embudo, Desempeño, Reportes y Widget de
WhatsApp) son ahora 5 pestañas de una sola pantalla, con **una sola entrada en el menú** («Analítica», en
Principal). Arriba quedan siempre los mismos filtros —período, asesor, equipo, canal—, que se aplican al instante
a la pestaña activa y viajan al cambiar de pestaña. Si un filtro no aplica en una pestaña (por ejemplo el período
en el Embudo, que es una foto de hoy), se ve atenuado y una nota dice por qué. Las rutas viejas redirigen con sus
filtros (`/dashboard` → `/analytics`, `/funnel` → `/analytics/embudo`, etc.), así que no se rompe ningún marcador.

**Es un cambio de presentación, no de datos.** Cada pestaña hace las mismas consultas y los mismos cálculos de
`lib/analytics.ts` que hacía su página. El permiso sigue siendo `reports:read` (ver) y `reports:export` (botón de
CSV y ruta de exportación), y cada rol sigue viendo solo lo que ya veía (lo decide la base de datos). Tres
mejoras de comportamiento, a propósito y a la vista:
- Embudo, Desempeño y Reportes **ahora respetan los filtros de asesor y equipo** (antes solo el Dashboard).
- La **exportación a CSV respeta los mismos filtros** que se ven en pantalla (antes ignoraba asesor/equipo/canal).
  El CSV de desempeño trae además el equipo y las tareas completadas.
- El texto del embudo dice «equivale al X% de la etapa anterior» en vez de «X% pasó»: como compara cuántas hay
  HOY en cada etapa, puede pasar de 100%, y «pasó el 133%» era imposible de entender.

**Diseño.** Tarjetas con ícono de color y variación contra el período anterior (verde/rojo, gris si no cambió),
gráficos de área para tendencias, donas para distribuciones (canal, fuente, equipo, valor por etapa), columnas
para ventas por mes y por persona, un embudo que se angosta etapa a etapa y un ranking por persona con avatar.
**Sin librería nueva**: los gráficos son SVG propios dibujados en el servidor (no agregan JavaScript), con su dato
exacto como tooltip, animación de entrada que respeta «reducir movimiento», y modo oscuro con los colores del
proyecto. Los ejes usan cifras redondas (y enteras para conteos); las cifras largas se achican para caber.

**Cambiar de pestaña o de filtro no recarga la página** (cliente de Next, dentro de una transición de React: el
contenido actual se atenúa con una barra de progreso hasta que llega el nuevo).

## Cuatro errores reales encontrados con el navegador (ninguna prueba automática los veía)
1. **El más serio: dos filtros cambiados seguidos podían mostrar datos que no correspondían a la URL** (1 de cada
   ~40 veces: la URL decía «Medellín + WhatsApp» y los datos eran solo de «Medellín», y así quedaba). Causa: dos
   navegaciones del router en paralelo, y la primera, resuelta tarde, pisaba a la segunda. Solución de diseño:
   nunca hay dos en vuelo (`navRequest`/`navCommitted` en `lib/analytics.ts`, con pruebas); la barra muestra al
   instante lo último que se pidió y la pantalla va directo a eso. Comprobado: 60 de 60.
2. **A veces el router de Next deja sin terminar una navegación que solo cambia `?filtros`** (~10–20% en este
   entorno). No es de esta pantalla: pasa igual en el filtro de **Leads**, que no se tocó. Se descartó con
   pruebas el servidor, el prefetch, las fuentes, el navegador y la compresión; la causa interna de Next no quedó
   identificada. Analítica tiene una red de seguridad: si a los 2,5 s no llegó, reintenta; a los 6 s, carga la
   página completa. Comprobado: 40 de 40 llegan con los datos correctos. **Leads y Oportunidades siguen sin esa
   protección** (no se tocaron).
3. Visuales: cifras de las tarjetas que se cortaban, eje «0,25 leads», eje de ventas con fechas internas
   («2026-10-01», heredado del Dashboard), cifra central de la dona que se salía del aro, barras del ranking
   desalineadas entre filas y, en móvil, el monto del ranking partido en dos líneas.
4. Al pasar el filtro en un `ref` durante el render, la red de seguridad creía que una navegación suspendida ya
   había llegado y nunca actuaba: las refs ahora se actualizan solo al confirmarse.

## Verificación de la pantalla única
- Unitarias: lógica de pestañas, filtros, cola de navegación, dona, ejes e iniciales (`lib/analytics.test.ts`).
- Integración contra PostgREST real: canales del filtro según el rol, y el alcance compartido por pestañas y CSV.
- Navegador real (build de producción), con datos sembrados por los caminos reales: KPIs contra la base de
  datos, cambio de pestaña sin recarga, filtros que viajan, atrás/adelante, clics rápidos, los 3 CSV, rutas viejas,
  una vendedora y un jefe viendo solo lo suyo, botón de exportar según permiso, móvil y modo oscuro.
