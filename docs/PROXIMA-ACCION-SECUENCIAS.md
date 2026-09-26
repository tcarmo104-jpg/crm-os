# Mi próxima acción y Secuencias — qué se construyó (Fase 7)

## Diagnóstico
- **«Mi próxima acción»** solo existía como una tarjeta en el dashboard «Hoy», que elegía un único ítem
  urgente y descartaba el resto. No había una pantalla con la fila completa de trabajo pendiente.
- **«Secuencias»** no existía. Descubrimiento importante: los permisos `sequences:read`/`sequences:manage`
  ya estaban definidos y asignados a los roles correctos desde la Fase 1 — solo faltaba construir la
  funcionalidad. Se respetó ese diseño ya decidido sin cambiar ningún permiso.
- **Decisión de arquitectura:** este CRM no tiene tareas en segundo plano (sin cron). Cada paso de una
  secuencia se dispara solo al completar el paso anterior, reutilizando el mismo mecanismo que ya completa
  cualquier tarea (`app.task_transition`). Cero infraestructura nueva.

## Qué se construyó

**Mi próxima acción** (`/next-action`): la fila COMPLETA de trabajo pendiente (tareas vencidas, luego
conversaciones sin responder, luego tareas de hoy), cada una en el orden correcto, con un botón para
completarla ahí mismo o abrir el cliente. Reutiliza los mismos datos que ya alimentan la tarjeta de «Hoy»
(`lib/today.ts`, función nueva `buildActionQueue`, pura y probada).

**Secuencias** (`/sequences`, migración `0025`): plantillas de seguimiento con pasos (tipo, prioridad,
días de espera). Inscribir a un cliente desde su ficha crea la tarea del primer paso; los siguientes se
crean solos, a medida que se completa cada uno. Se puede pausar, reanudar o cancelar una inscripción.

## Errores reales encontrados y corregidos
1. **Dos guardas estructurales ya existentes** (privilegios de `anon`, registro de fusión de clientes)
   detectaron que me faltaba revocar accesos y registrar la tabla nueva — corregido antes de continuar.
2. **El más importante:** al redefinir `merge_customers` para el caso nuevo, copié por error una versión
   *antigua* de esa función (de una migración anterior a la que realmente estaba en uso) y sin querer
   **eliminé una funcionalidad ya existente**: reasignar las tareas abiertas del cliente absorbido al
   responsable del cliente resultante. Una prueba ya existente lo detectó de inmediato; se corrigió
   restaurando esa lógica dentro de la nueva definición.
3. **Caso real encontrado con pruebas propias:** fusionar dos clientes que tienen la misma secuencia activa
   rompía una restricción de unicidad. Ahora la inscripción del cliente absorbido se cancela automáticamente
   en ese caso, en vez de fallar.
4. **Bug de Next.js real:** un `redirect()` colocado dentro de un bloque `try/catch` queda atrapado por el
   propio `catch` (Next.js implementa la redirección lanzando una señal especial). El resultado visible era
   que crear una secuencia funcionaba, pero la pantalla mostraba «No pudimos completar la acción» en vez de
   llevar al detalle. Corregido moviendo el `redirect()` fuera del `try`, con el mismo patrón que ya usa el
   resto del código (`createCustomerAction`).
5. Las acciones de pausar/reanudar/cancelar debían declararse como funciones `async` directas — un archivo
   `'use server'` no admite exportar una constante que solo referencia otra función.

## Verificación
- 469 pruebas unitarias, suite SQL completa (con mutaciones sobre los puntos críticos), y 255 de
  integración contra Postgres/PostgREST reales, incluida la cadena completa sin cron (inscribir → completar
  paso 1 → avanza solo a paso 2 → completar → queda «completada»).
- 18 comprobaciones en navegador real: crear una secuencia con varios pasos, inscribir un cliente desde su
  ficha, ver la inscripción, pausarla, completar tareas desde «Mi próxima acción», y responsive en móvil.
