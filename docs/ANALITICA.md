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
