# CRM OS — Sistema operativo comercial

Plataforma SaaS multi-tenant: **Customer 360 + Sales Execution + Omnicanal + Automatización + IA + Analytics**.
Stack: Next.js 15 · TypeScript · Supabase (PostgreSQL, Auth) · Vercel.

- Diseño y decisiones: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Despliegue paso a paso:** [`docs/DEPLOY.md`](docs/DEPLOY.md)

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Multi-tenancy, RBAC con alcance, RLS, auditoría, event stream | ✅ |
| 1b | Invitaciones, app (login, organizaciones, menú, miembros, equipos), endpoint de eventos, CI | ✅ (falta validar en staging) |
| 2 | Customer 360, resolución de identidad, captura de leads (CSV y API), duplicados, campos personalizados | ✅ (falta validar en staging: ver `docs/DEPLOY.md`) |
| 3 | Pipelines, oportunidades, tareas y actividades, log de transiciones, máquina de estados de leads | ✅ (falta validar en staging: ver `docs/DEPLOY.md`) |
| 4 | Catálogo de productos y servicios, cotizaciones versionadas, ventas con foto inmutable, seguimiento postventa y casos | ✅ (falta validar en staging: ver `docs/DEPLOY.md`) |
| 5 | Inbox omnicanal (WhatsApp, Instagram, correo) | siguiente |

## Estructura

```
src/
  app/            páginas y server actions (orquestan, sin lógica comercial)
  components/     UI (menú lateral colapsable, formularios, temas)
  services/       validación (zod) y reglas de negocio
  repositories/   único lugar que consulta Supabase
  server/         procesos de fondo: dispatcher de eventos (solo servidor)
  lib/            sesión, errores, navegación, utilidades
supabase/
  migrations/     0001 fundación · 0002 auditoría+eventos · 0003 onboarding
                  0004 visibilidad de clientes · 0005 invitaciones+API de workers
                  0006 campos personalizados · 0007 clientes+identidad+leads
                  0008 captura de leads + llaves de API
                  0009 pipelines, oportunidades, log de transiciones, endurecimiento de accesos
                  0010 tareas y actividades
  tests/          pruebas SQL: aislamiento, RBAC, invitaciones, identidad, ingesta, campos,
                  pipelines, oportunidades, tareas
  integration/    (en src/) pruebas de repositorios y API contra PostgREST real
scripts/          test-db.sh · test-concurrency.sh · test-postgrest.sh
.github/workflows/ci.yml
```

## Comandos

```bash
npm install
npm run dev            # desarrollo (requiere .env.local, ver .env.example)
npm run typecheck      # tipos
npm test               # pruebas unitarias
npm run build          # build de producción
npm run test:db        # migraciones + pruebas SQL + concurrencia (requiere PostgreSQL local)
npm run test:integration  # repositorios y API contra PostgREST (requiere su binario, ver el script)
```

## Reglas que las pruebas protegen (no romper)

- Toda tabla de `public` tiene RLS; `anon` no tiene privilegios sobre ellas.
- Los datos de una organización nunca son visibles ni modificables desde otra.
- `authenticated` no puede insertar en `organizations`, `audit_logs` ni `domain_events`.
- Nadie se auto-escala a `super_admin`; toda organización conserva al menos uno.
- Vendedor ve solo sus clientes; sales manager, los de su equipo; admin y manager, todos.
- El token de invitación nunca se guarda ni se audita en claro; aceptar exige el mismo correo verificado.
- `service_role` solo se usa en `src/server/`, nunca en código de usuario ni en el navegador.
- Un identificador (teléfono, correo, usuario) pertenece a un solo cliente por organización; los duplicados **nunca** se fusionan solos.
- Un vendedor que intenta crear un contacto ajeno no recibe ningún dato del cliente existente (respuesta genérica).
- «No contactar» lo levanta solo un manager/admin y sobrevive a la fusión.
- Toda tabla que referencie a `customers` debe estar cubierta por `merge_customers` (una prueba estructural lo exige).
- Los campos personalizados se validan en la base de datos, no solo en la interfaz.
- La API pública nunca revela si una persona ya era cliente; las llaves se guardan solo como SHA-256.
- `can_access_row` nunca devuelve NULL (un registro sin propietario no es accesible por nadie con alcance propio/equipo).
- Todo cambio de estado de un lead u oportunidad queda en `state_transitions` (append-only) y solo se hace por RPC.
- Perder una oportunidad exige motivo; reabrir una cerrada exige manager/admin; «convertido» solo con `convert_lead`.
- Una oportunidad nunca es más visible que su cliente (propietario heredado; matriz de permisos fijada por prueba).
- Las tareas y actividades solo se vinculan a lo que la persona ya puede ver; las actividades son inmutables.
- Los eventos del mismo request se ordenan de verdad (`clock_timestamp()`, no `now()`).

