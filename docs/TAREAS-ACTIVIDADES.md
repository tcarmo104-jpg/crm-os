# Tareas y Actividades — qué cambió

Mejora enfocada solo en estos dos módulos. No se tocó ninguna otra pantalla, integración ni la base de datos de otros módulos.

## Diagnóstico (antes de tocar código)
- **Tareas** era una lista plana: sin Kanban, sin filtro por tipo/prioridad/cliente, sin buscador.
- **La edición de una tarea no existía en pantalla**, aunque el código para hacerlo (`editTask`) ya estaba escrito en el servicio y nunca se conectó a ningún botón.
- **Actividades no era un módulo**: no tenía página propia ni entrada de menú; solo se veía dentro de una oportunidad o de un cliente.
- **Distinción de producto que se mantuvo:** una *Actividad* es algo que **ya pasó** (llamada, reunión, nota) y es inmutable a propósito, para no permitir reescribir el historial; una *Tarea* es algo **por hacer**, con vencimiento y responsable. Por eso «vencida» es una condición visual sobre una tarea abierta, no un estado nuevo, y por eso Actividades no tiene «próximas» ni prioridad.

## Tareas
- **Estado nuevo «En progreso»** entre Pendiente y Completada/Cancelada (migración `20260919000023`).
- **Tipo nuevo «Visita»** (tareas y actividades).
- **Edición conectada por fin a la pantalla** (modal compacto): título, tipo, prioridad, fecha, responsable, descripción.
- **Vista Lista** (agrupada por vencimiento, como antes, mejorada) y **vista Tablero** (Kanban por estado, con botones para mover entre columnas en vez de arrastrar — ver «Decisiones» abajo).
- **Filtros**: estado, tipo, prioridad, responsable, búsqueda por texto; se combinan y quedan en la URL (se pueden compartir/guardar).
- **Creación** desde cualquier parte, con cliente y oportunidad relacionados (antes solo se podía crear una tarea desde dentro de la ficha de un cliente).

## Actividades (módulo nuevo)
- Página propia (`/activities`) y entrada en el menú, junto a Tareas.
- **Historial** agrupado por día («Hoy», «Ayer», fecha), con icono por tipo.
- **Filtros**: tipo, cliente, responsable, rango de fechas, búsqueda por texto.
- **Registro** en un modal compacto; sigue siendo inmutable (no se edita: un error se corrige con una nota nueva).

## Vistas evaluadas y descartadas
- **Calendario** en ambos módulos: una tarea vencida ya se distingue con claridad en la Lista y en el Tablero; un calendario de actividades que **ya ocurrieron** (por diseño, en el pasado) aporta poco frente a un historial ya ordenado por fecha. Se prefirió hacer bien dos vistas a añadir una tercera de relleno.
- **Kanban de Tareas sin arrastrar y soltar**: se evaluó reproducir el arrastre de Oportunidades (con `@dnd-kit`), pero implica una máquina de estados con diálogo de confirmación mucho más grande. Se optó por columnas con botones (Empezar / Completar / Cancelar / Reabrir): mismo resultado visual, más simple, accesible por teclado.

## Qué NO se tocó
Inbox, Oportunidades, Clientes, Conexiones, y el formulario de tarea/actividad que ya existía dentro de la ficha de un cliente (`sales-forms.tsx`, usado por `/customers/[id]`) siguen exactamente igual. Los módulos nuevos son una alternativa más completa para quien entra desde Tareas/Actividades directamente, no un reemplazo de esa pantalla.

## Errores reales encontrados (con navegador real, no solo pruebas automatizadas)
1. **Un `Intl.DateTimeFormat` se pasaba de un componente de servidor a uno de cliente** (no es serializable): la página fallaba con «Application error» en cuanto había una tarea que mostrar. Se corrigió pasando el locale/huso horario como texto y construyendo el formato dentro del componente de cliente.
2. **El modal no se cerraba solo tras guardar**: dependía de `document.activeElement`, que no es confiable durante el envío de un formulario. Se corrigió con un contexto de React propio del modal (`CloseOnSuccess`), reutilizable para cualquier modal futuro.

## Verificación
- 448 pruebas unitarias, suite SQL completa, y 240 de integración contra Postgres/PostgREST reales (10 nuevas de esta fase).
- Navegador real: 23 comprobaciones sobre crear, editar, «Empezar» → «En progreso», completar, Tablero, filtros, registrar actividad (con y sin dirección), y responsive en móvil.
