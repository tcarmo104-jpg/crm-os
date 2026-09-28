# Dashboard ejecutivo — qué se construyó

Mejora exclusiva del Dashboard (nada más se tocó). Auditoría completa entregada antes de escribir
código: qué datos existen realmente, qué KPIs se pueden calcular, y qué NO se puede construir hoy
(no existe ningún campo de «sucursal» en el sistema; no se inventó).

## Qué se construyó
- **Filtros globales** (un solo formulario, sin JavaScript): período (9 opciones + personalizado),
  personas, equipos, canal. Con chips de filtros activos y «Limpiar».
- **8 KPIs ejecutivos**, cada uno con comparación contra el período anterior (↑/↓ %), que no se muestra
  cuando no hay con qué comparar (evita un «0%» o un «∞%» engañoso).
- **Gráfico de evolución** en SVG propio, sin agregar ninguna librería nueva. Separado en dos: cantidad
  (leads/oportunidades) y monto (ventas) — mezclarlos en un solo eje hacía invisibles a los números
  pequeños frente a los montos en millones (ver «Errores encontrados»).
- **Embudo comercial** (reutiliza el mismo cálculo del módulo Embudo), **leads por canal**, **ventas por
  equipo y por región** (`teams.region`, ya existía, nunca se había usado), **desempeño por persona**.
- **Sección de Atención**: tareas vencidas, leads pendientes de contactar, oportunidades con fecha de
  cierre vencida, cotizaciones enviadas sin seguimiento — cada una con un enlace real a su módulo.
- Sin migración: todo con datos y permisos que ya existían.

## Lo que se evaluó y NO se construyó (con la razón)
- **Sucursal**: no existe ningún campo para esto en el esquema. No se inventó un dato falso.
- **Drill-down en cada barra de cada gráfico**: se revisó cuáles módulos ya aceptan un filtro por URL
  antes de prometerlo. Los KPIs y las Alertas sí llevan a un filtro real. Las barras de distribución (por
  canal, equipo, región) todavía no son clicables, porque los módulos de destino no tienen ese filtro
  específico disponible por URL hoy — se dejó anotado para una siguiente fase en vez de simular un enlace
  que no haría nada.

## Tres errores reales encontrados y corregidos (con navegador real)
1. **Tres enlaces de «ver el detalle» apuntaban a filtros que esas páginas no reconocen** (`estado=vencidas`
   en Tareas, `estado=won` en Oportunidades, `estado=sent` en Cotizaciones). Se corrigieron a enlaces que
   sí funcionan, y para «cotizaciones sin seguimiento» se implementó el conteo real en vez de dejarlo en
   cero.
2. **El gráfico de evolución no mostraba nada** cuando había muy pocos puntos de datos (una sola fecha):
   una línea con un solo punto no tiene nada que dibujar. Se agregaron marcadores.
3. **Mezclar «Ventas» (montos en millones) con «Leads»/«Oportunidades» (unidades) en un solo eje** hacía
   invisibles a estos últimos frente al monto. Se separó en dos gráficos, cada uno con su propia escala.

## Verificación
- 494 pruebas unitarias (25 nuevas de esta fase).
- 16 comprobaciones en navegador real con datos sembrados de verdad (un equipo con región, ventas,
  oportunidades en varias etapas, leads de varios canales): filtros aplicados y limpiados, alertas con
  enlaces reales, comparación contra el período anterior con datos reales del mes pasado.
