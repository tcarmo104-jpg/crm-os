# Roles y permisos personalizados, y Configuración general — qué se construyó (Fase 13)

## Diagnóstico
Al investigar antes de tocar código, encontré que **la estructura ya soportaba roles personalizados desde
la Fase 1** (`roles.org_id`: nulo = rol de sistema, no nulo = rol propio de la organización), y el permiso
`roles:manage` ya existía, otorgado a `super_admin` y `admin`. Solo faltaban las funciones para crear y
editar un rol, y la pantalla. También encontré que **asignar un rol nuevo a una persona no necesita ningún
cambio**: la función que ya mueve a alguien de rol acepta cualquier id de rol válido de la organización, sea
de sistema o propio.

Para «Configuración general», la política de base de datos para editar el nombre, zona horaria, idioma y
moneda de la organización **ya existía** (gatillada por `settings:manage`) — solo faltaba la pantalla.

## Qué se construyó
- **Migración 0027**: funciones para crear, renombrar, cambiar los permisos y borrar un rol propio.
  Los roles de sistema **nunca** se pueden tocar con estas funciones — verificado con una prueba dedicada.
- Catálogo completo de permisos (`lib/roles.ts`): 9 módulos × 4 acciones (Ver/Crear/Editar/Eliminar) + 14
  permisos especiales de configuración — coincide exactamente con lo que ya existía en la base de datos,
  nada inventado.
- Pantalla `/settings/roles`: lista (roles de sistema y propios), crear un rol nuevo con una cuadrícula de
  permisos (cada uno con su alcance: propio/equipo/organización), editar, eliminar.
- Pantalla `/settings/general`: nombre, zona horaria, idioma y moneda de la organización.
- Se integraron los roles propios en la pantalla de Miembros, para poder asignarlos de verdad a una persona
  (no se tocó el flujo de invitación: sigue mostrando solo roles de sistema, por ahora).

## Guardas de seguridad reales (probadas)
- Un rol de sistema nunca se puede renombrar, editar ni borrar con estas funciones nuevas.
- No se puede borrar un rol que alguien tiene asignado en este momento.
- La clave técnica de un rol no se puede repetir dentro de la misma organización.
- Un rol de una organización no se puede tocar desde otra organización.

## Dos errores reales encontrados y corregidos
1. **La compilación de producción falló** por exportar dos constantes (`TIMEZONE_OPTIONS`, `LOCALE_OPTIONS`)
   directamente desde un archivo `page.tsx` — Next.js no lo permite, y esto solo se detecta en `next build`,
   no con una revisión de tipos normal. Se movieron a un módulo aparte (`lib/org-settings.ts`).
2. **Al verificar en un navegador real**, until confirmé con una prueba directa contra la base de datos que
   los límites reales de un rol personalizado se respetan de punta a punta: una persona con un rol que solo
   tiene `leads:read` y `tasks:create` no puede ver Oportunidades, y **sí puede** en cuanto se le agrega ese
   permiso al rol — sin tocar su membresía.

## Verificación
- 509 pruebas unitarias (26 nuevas de esta fase), 10 pruebas SQL con 4 mutaciones de seguridad (todas
  detectadas), y 270 de integración contra Postgres/PostgREST reales.
- 19 comprobaciones en navegador real: crear un rol, asignarlo, confirmar sus límites reales antes y
  después de editar sus permisos, intentar borrar uno en uso (rechazado), y Configuración general.
