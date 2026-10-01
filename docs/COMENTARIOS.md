# Módulo de Comentarios de Facebook e Instagram — qué se construyó

## Diagnóstico y decisión de diseño
Un comentario es público y vive debajo de una publicación — no es una conversación privada uno a uno, así
que **no entra en el Inbox** como una conversación más: se construyó como un módulo nuevo y separado, con
sus propios permisos.

Investigué la documentación actual de Meta antes de construir nada:
- Facebook entrega los comentarios dentro de su webhook general `feed` (no uno aparte) — se filtra por
  `item=comment`. Instagram los entrega en su propio campo `comments`.
- La respuesta **privada** a un comentario usa el mismo endpoint que ya usaba el CRM para enviar mensajes de
  Messenger/Instagram Direct (`/PAGE-ID/messages`), solo cambia qué va en `recipient`. Por eso, al enviarla,
  también se registra como un mensaje saliente normal y **cae en el Inbox de siempre**.
- Se agregaron los permisos que Meta exige (`pages_manage_engagement`, `instagram_manage_comments`) a lo que
  el CRM le pide al conectar la app — **hace falta volver a conectar Facebook Messenger una vez** para que
  Meta entregue estos permisos nuevos (los anteriores siguen funcionando igual).

## Qué se construyó
- Tablas para publicaciones y comentarios, con permisos nuevos (`comments:read`, `comments:manage`)
  otorgados a administradores, manager, marketing y atención al cliente — no a vendedores.
- Ingesta automática: cada comentario que llega por el webhook se guarda solo, enlazado con el cliente del
  CRM si ya existía.
- Responder en público, responder en privado (con el aviso cuando ya pasaron los 7 días que Meta permite),
  ocultar/mostrar, eliminar — cada acción llama primero a Meta, y solo si Meta confirma, se guarda el cambio.
- Pantalla nueva «Comentarios» con las publicaciones y sus comentarios (con las respuestas anidadas debajo
  de cada uno), y un botón para traer las publicaciones más recientes.

## Un error de seguridad real que encontré verificando en un navegador real (no en las pruebas automáticas)
Al probar «Responder en público» de verdad, me salió «No tienes permiso para hacer esto» pese a que el
usuario de prueba sí tenía el permiso correcto. Investigué y encontré la causa: **el token de un canal
nunca se puede leer con la sesión de la persona que usa el CRM** — es una barrera de seguridad deliberada en
todo el proyecto (los tokens solo los puede leer el propio servidor). Mi primera versión del servicio violaba
esa regla. Se corrigió usando el cliente de administrador solo para esa parte, y agregué una prueba
específica que confirma que esto no se vuelva a romper. Las pruebas unitarias con todo simulado no habían
detectado esto — solo apareció al probarlo de verdad, que es justo para lo que sirve esa verificación.

## Verificación
- 22 pruebas SQL (ingesta, permisos, respuesta conectada al Inbox), con 6 mutaciones de seguridad, todas
  detectadas.
- 23 pruebas unitarias nuevas (el lector del webhook de comentarios, las funciones que llaman a Meta, y el
  servicio que las orquesta — incluida la prueba del error de seguridad que encontré).
- 3 pruebas de integración contra Postgres/PostgREST reales.
- 15 comprobaciones en navegador real, con comentarios sembrados de verdad: ver, responder en público,
  responder en privado (confirmado que crea una conversación real en el Inbox), ocultar, eliminar.
