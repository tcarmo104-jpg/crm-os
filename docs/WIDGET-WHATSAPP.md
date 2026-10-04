# Widget de WhatsApp para sitios web — Fase 1 (lo esencial de punta a punta)

## Decisión de diseño (confirmada contigo antes de construir)
El botón **no abre un chat en vivo dentro de la página** — eso no es posible de forma legítima con la API
oficial de WhatsApp Business para un visitante anónimo, y tu propia especificación pedía evitar cualquier
cosa que no sea la API oficial.

En vez de eso: el visitante llena su nombre, WhatsApp y mensaje (con toda su atribución: página, producto,
UTMs, referido), el CRM crea o encuentra el contacto, y el navegador del visitante se **redirige a WhatsApp**
con el mensaje ya escrito. Cuando el visitante le da «Enviar» ahí, ese mensaje llega a tu número real de
WhatsApp Business y entra al Inbox exactamente como cualquier mensaje de WhatsApp — nada nuevo que tocar ahí.

## Qué se construyó
- Generador de widgets (Configuración → WhatsApp → Widgets): nombre, número conectado, texto del botón,
  mensaje de bienvenida, posición, color, tamaño, mostrar/ocultar texto, dominios autorizados.
- Código de instalación de una sola línea, que no hay que volver a tocar si cambias la configuración.
- Un script embebible propio (sin dependencias, con sus propios estilos para no chocar con el sitio donde
  se instale) que dibuja el botón, abre el formulario, y redirige a WhatsApp.
- Reutiliza `app.ingest_lead_core` — el mismo motor que ya usa la API pública de leads — para crear o
  encontrar el contacto sin duplicar nada.
- Seguridad: el «Widget ID» es público a propósito (va en el HTML del sitio del cliente). La protección real
  es **validar el dominio** desde el que llega cada solicitud, y un **límite de 20 solicitudes por minuto**
  por widget — igual que ya se hace con las llaves de API, pero sin una llave secreta expuesta en el sitio.

## Dos errores reales encontrados y corregidos al verificar en un navegador real
1. **El más serio: el script y los dos endpoints públicos quedaban bloqueados por el sistema de inicio de
   sesión del CRM.** Cualquier visitante anónimo de un sitio web —que nunca tiene sesión iniciada en el
   CRM— habría visto el widget simplemente no funcionar. Se encontró el mecanismo correcto ya existente en
   el proyecto (`SELF_AUTH_PREFIXES`, el mismo que usan los webhooks de Meta) y se usó ahí, en vez de la
   lista de páginas públicas (que es para otra cosa).
2. Al construir una página de prueba simulando un sitio externo real (en otro puerto, para probar de verdad
   cruzando dominios), un archivo de mi propia prueba quedó con texto corrupto por un error mío al capturar
   la salida de un comando — generó una serie de «falsos 404» que investigué a fondo antes de confirmar que
   la aplicación en sí estaba bien.

## Verificación
- 22 pruebas SQL (incluida la validación de dominio y el límite de velocidad, probado de verdad con 25
  solicitudes seguidas), con 3 mutaciones de seguridad, todas detectadas.
- 19 pruebas unitarias nuevas, 3 de integración contra Postgres/PostgREST reales.
- **Verificación de punta a punta con un sitio externo real** (servido en un puerto distinto, simulando un
  dominio ajeno): se abrió el botón, se llenó el formulario, se confirmó que redirige a WhatsApp con el
  número correcto de la empresa y el mensaje del visitante bien armado, y que el contacto con toda su
  atribución (UTMs, página de origen) quedó creado en el CRM.

## Qué queda para las siguientes fases (ya lo hablamos)
- Fase 2: botón «Crear oportunidad»/«Crear cotización» desde una conversación del Inbox, y mostrar el origen
  exacto del widget en la ficha del cliente.
- Fase 3: reglas de distribución automática (round robin, por región, por equipo, por horario).
- Fase 4: métricas específicas del widget en el Dashboard.
- Fase 5: vista previa en vivo del botón, tabla de administración con estadísticas por widget.
