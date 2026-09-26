# Clientes y Leads — qué cambió

Mismo tratamiento que Tareas y Actividades: rediseño funcional completo de ambos módulos.

## Diagnóstico (antes de tocar código)
- **Clientes**: la lista solo filtraba por nombre/teléfono/correo y responsable. La ficha de un cliente era una sola columna
  larga con unas 12 secciones apiladas, sin orden visual. No mostraba los archivos del cliente (ese panel existía, pero
  solo en el Inbox). No usaba las etiquetas, aunque ya existían en la base de datos.
- **Leads**: la lista no tenía ningún filtro ni buscador. No había forma de crear un lead a mano, solo por CSV o API.

**Hallazgo clave:** ya existía un sistema de etiquetas para clientes (tabla `customer_tags`), construido para el Inbox y
nunca usado en Clientes ni Leads. Y ya existía la lógica de identidad para crear un lead (`app.ingest_lead_core`, la
misma que usa la importación CSV), solo le faltaba una puerta de entrada individual. Ambas cosas se reutilizaron
completas, sin duplicar ninguna regla.

## Qué cambió

**Clientes**
- Filtros nuevos: etiqueta, ciudad, tipo (persona/empresa), «no contactar», además de los que ya había.
- Etiquetas visibles y editables en la lista y en la ficha (mismo componente reutilizable en toda la app).
- La ficha se reorganizó en **4 pestañas**: Resumen, Actividad y tareas, Comercial, Archivos. Todo lo que ya existía
  se conservó; solo cambió el orden y la agrupación.
- Pestaña **Archivos** nueva, reutilizando el panel que ya existía en el Inbox.
- Enlaces de salida a las vistas completas de Tareas y Actividades, filtradas por ese cliente.

**Leads**
- Filtros nuevos: estado, fuente, resultado, responsable, rango de fechas, texto.
- **Crear un lead a mano** (migración `0024`, `create_lead`): un envoltorio delgado sobre la misma resolución de
  identidad que ya usa la importación CSV. Si la persona ya era cliente, el lead queda anexado a su ficha sin
  duplicarla.
- Etiquetas del cliente visibles en la tabla de leads.

## Errores reales encontrados y corregidos (con navegador real)
1. **Las etiquetas no se veían solas tras agregarlas o quitarlas** (se guardaban bien, pero la pantalla no se
   actualizaba). Causa: las acciones nuevas no terminaban con un `redirect()`, a diferencia del patrón que ya usa
   el resto del CRM para forzar datos frescos. Corregido.
2. **`.panel` y `.page` (clases compartidas de todo el sistema de diseño) no tenían `min-width: 0`.** Una tabla ancha
   dentro de un `.panel` podía forzar a toda la página a desbordarse en pantallas angostas. Corregido de forma
   general, no solo para Leads.
3. **Un elemento de accesibilidad (`sr-only`) dentro de una tabla escapaba de su contenedor con scroll** porque
   `.table-wrap` no tenía su propio contexto de posicionamiento (`position: relative`). Corregido.
4. **Un menú desplegable (`.task-complete-form`, compartido con Tareas) quedaba técnicamente visible aunque estuviera
   «cerrado»**, porque forzaba `display: flex` sin importar el estado del `<details>`, anulando el comportamiento
   nativo del navegador. Corregido; esto también mejora Tareas, sin cambiar su funcionalidad.

## Verificación
- 453 pruebas unitarias, suite SQL completa (con mutaciones sobre `create_lead`) y 249 de integración contra
  Postgres/PostgREST reales — todas en verde.
- 22 comprobaciones en navegador real para Clientes/Leads, y se repitieron las 23 de Tareas/Actividades para
  confirmar que las correcciones de CSS compartido no rompieron nada ahí.
