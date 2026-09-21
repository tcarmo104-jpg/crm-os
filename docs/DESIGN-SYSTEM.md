# Sistema de diseño del CRM

**Regla de oro:** ningún módulo define colores propios. Todo sale de los *tokens* de `src/app/globals.css`. Los módulos (Inbox `.ib`, Oportunidades `.kb`, Conexiones `.cx`)
solo tienen *alias* hacia esos tokens. Si cambias `--primary`, cambia el CRM entero, claro y oscuro.

## Identidad
Azul zafiro (acción) sobre lienzo claro, menú marino con personalidad propia y un único color de «señal» (ámbar) reservado para «haz esto AHORA».
Referencia de nivel: productos SaaS empresariales como Siigo (limpieza, jerarquía, navegación agrupada, color con intención); identidad propia.

## Tokens
| Grupo | Tokens |
|---|---|
| Acción | `--primary` `--primary-hover` `--primary-soft` `--primary-ink` `--focus` `--ring` |
| Neutros | `--canvas` (fondo) `--surface` (tarjetas) `--surface-2` (zonas hundidas) `--hover` `--line` `--line-soft` `--line-strong` `--ink` `--ink-2` `--muted` |
| Estado | `--ok` éxito/activo · `--warn` atención/pendiente · `--danger` error · `--info` información · `--neutral` inactivo · `--signal` «ahora» (cada uno con `-soft`) |
| Menú | `--side-bg` `--side-bg-2` `--side-ink` `--side-muted` `--side-hover` `--side-active` |
| Canal | `--ch-whatsapp` `--ch-messenger` `--ch-instagram` `--ch-gmail` (marcas de terceros, no son estado) |
| Tipografía | Inter · `--fs-h1` 26 · `--fs-h2` 18 · `--fs-h3` 16 · `--fs-body` 15 · `--fs-small` 13 · `--fs-caption` 12 · `--fs-section` 11 (mayúsculas) |
| Espaciado | `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 20 · `--s-6` 24 · `--s-8` 32 · `--s-10` 40 |
| Forma | `--r-control` 8 · `--r-panel` 12 · `--r-pill` · `--shadow-1` (casi imperceptible) · `--shadow-2` (menús y modales) |

**Un estado = un color en todo el CRM.** Éxito/activo/conectado → verde; atención/pendiente → ámbar; error/destructivo → rojo; información/selección → azul; inactivo → gris.

## Componentes globales (clases)
`.btn` (+ `-primary` `-secondary` `-ghost` `-danger` `-success` `-sm`) · `.input` `.select` (foco azul, `aria-invalid`, `:disabled`) · `.panel` · `.stat` · `.table` (encabezado claro, hover) ·
`.badge` (+ `-ok` `-warn` `-danger` `-info` `-neutral`) · `.tabs` · `.notice` · `.empty-state` · `.avatar` · `.kpi` / `.kpi-grid` (indicador: cifra grande + contexto) · `.row-list` / `.row-item` (filas) ·
`.funnel` (barras por etapa) · `.next-action` (+ `--urgent` `--todo` `--clear`) · `.quick-tile` · `.skeleton` (carga; `src/app/(app)/loading.tsx`).
Los enlaces dentro de una tabla son azul de marca sin subrayado fijo.

## Estructura
- **Menú lateral** marino, grupos en mayúsculas pequeñas, módulo activo = bloque azul lleno; colapsable a iconos con aviso al pasar el mouse; en móvil es un panel que se abre.
  Los módulos que aún no existen viven en «Próximamente» (plegado de fábrica) en `src/lib/nav.ts` (`key: 'soon'`).
- **Barra superior**: migas de pan (grupo › módulo), búsqueda global (clientes), organización, tema, persona.

## Cómo añadir un módulo sin romper la coherencia
1. Usa las clases globales (`.btn`, `.panel`, `.table`, `.badge`…). 2. Si necesitas variables propias, que sean *alias*: `--mi-acento: var(--primary)`, nunca un hex.
3. Estados solo con `--ok/--warn/--danger/--info/--neutral`. 4. Espacios solo con `--s-*`. 5. No definas `[data-theme='dark']` en tu módulo: el modo oscuro sale de los tokens.

## Portada «Hoy» (jerarquía en cuatro niveles)
1. **Indicadores** (`.kpi`): valor del pipeline, ganado 30 días, por responder, tareas para hoy. Cada uno lleva a su módulo y usa el color de su estado.
2. **Embudo** por etapa y **«Tu próxima acción»** (real: tarea atrasada → conversación por responder → tarea de hoy → primeros pasos → «todo al día»; respeta permisos).
3. **Actividad**: últimas conversaciones y tareas de hoy.
4. **Acciones rápidas** (solo las que el rol puede hacer). «Primeros pasos» aparece solo mientras falten pasos.
La lógica está en `src/lib/today.ts` (pura y probada); los estados vacíos siempre dicen qué es, por qué está vacío y qué hacer.

## Iconos
Un solo juego: `src/components/icon-shapes.tsx` (formas) + `Icon.tsx` (menú). Peso de trazo único (`STROKE = 1.75`). `Ico` (módulos) e `Icon` (menú) son el mismo componente.
Una prueba (`icons.test.ts`) falla si algún `<Icon name="…">` apunta a un icono que no existe.
