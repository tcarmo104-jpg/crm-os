# Conectar WhatsApp (API de Meta) — guía paso a paso

> **Actualización (Conexiones):** los números ya no se conectan en «Canales» sino en **Configuración → Conexiones**,
> que comprueba el token y el número con Meta **antes** de guardar y suscribe el webhook por ti. Ahora se pide además el
> **ID de la cuenta de WhatsApp Business** (junto al ID del número en Meta) y el token debe incluir los permisos
> `whatsapp_business_messaging` **y** `whatsapp_business_management`. Facebook, Instagram y Gmail: ver `docs/CONEXIONES.md`.


> **Aviso honesto:** esta guía está escrita con la documentación pública de Meta, **no se ha ejecutado contra tu cuenta**.
> Meta cambia los nombres de los menús con frecuencia. Si algo no coincide, mándame una captura y lo ajustamos.

## Qué necesitas
- Una cuenta de Facebook y acceso a **Meta for Developers** (developers.facebook.com).
- Tu app CRM ya desplegada (necesitas su dirección, p. ej. `https://crm-os-steel.vercel.app`).
- Para empezar **no necesitas un número propio**: Meta te da un **número de prueba** que puede escribir a hasta 5 celulares que tú agregues.

## Pasos
1. **Crear la app.** En Meta for Developers → *Mis apps → Crear app* → tipo **Business** (Empresa) → agrega el producto **WhatsApp**.
2. **Copiar el ID del número.** En *WhatsApp → Configuración de la API* verás un **«ID del número de teléfono»** (solo dígitos, ~15). Es el que pide el CRM. **No es el número de teléfono.** Ahí mismo agrega tu celular como destinatario de prueba.
3. **App Secret.** En *Configuración de la app → Básica → Clave secreta de la app → Mostrar*. Cópiala y guárdala en Vercel como `META_APP_SECRET` (**Sensitive**). Firma cada mensaje que Meta nos manda: sin ella el sistema rechaza todo.
4. **Token de verificación.** Inventa un texto largo y aleatorio (20+ caracteres). Guárdalo en Vercel como `META_VERIFY_TOKEN` (**Sensitive**). **Vuelve a desplegar** en Vercel para que lo lea.
5. **Webhook.** En *WhatsApp → Configuración* → *Editar* el webhook:
   - **URL de devolución de llamada:** `https://TU-APP.vercel.app/api/webhooks/meta` (también aparece en *Configuración → Canales* del CRM).
   - **Token de verificación:** el del paso 4.
   - Pulsa **Verificar y guardar**, y después en *Campos del webhook* **suscríbete a `messages`**.
6. **Token de acceso permanente.** El token temporal que muestra Meta **vence en unas 24 horas**; para uso real crea uno permanente: *Business Settings (Configuración del negocio) → Usuarios → Usuarios del sistema → Agregar* → asígnale tu app y tu cuenta de WhatsApp con control total → **Generar token** con los permisos `whatsapp_business_messaging` y `whatsapp_business_management`. Cópialo (empieza por `EAA…`).
7. **Conectar en el CRM.** *Configuración → Canales (WhatsApp) → Conectar un número*: nombre, ID del número (paso 2) y el token (paso 6). El token se guarda y **nadie puede volver a verlo**, ni tú.
8. **Probar.** Desde tu celular escribe al número de prueba. Debe aparecer en **Inbox**. Contesta desde el CRM.

## Plantillas (para escribir pasadas las 24 horas)
WhatsApp solo deja escribir libremente durante 24 h después del último mensaje del cliente. Después, **solo plantillas aprobadas por Meta**:
1. Créalas y espera su aprobación en *WhatsApp Manager → Plantillas de mensajes*.
2. Cuando estén aprobadas, cópialas al CRM en *Configuración → Canales → Agregar una plantilla*: **nombre, idioma y texto exactos**. Los datos variables se escriben `{{1}}`, `{{2}}`… en orden.

## Pasar a producción (más adelante)
Necesitarás un número propio que no esté activo en la app de WhatsApp, verificación del negocio en Meta y los precios por conversación de WhatsApp Business. Esta parte cambia con las políticas de Meta: revísala en su documentación al llegar ahí.

## Si algo falla
| Síntoma | Causa probable |
|---|---|
| «Verificar y guardar» falla | `META_VERIFY_TOKEN` distinto al que pegaste en Meta, o no volviste a desplegar tras agregarlo |
| Llegan mensajes a Meta pero no al CRM | No suscribiste el campo `messages`, o `META_APP_SECRET` está mal (la app responde 401 y no guarda nada) |
| En *Canales* aparece «Falta META_APP_SECRET» | La variable no está o falta volver a desplegar |
| Al responder: «Pasaron más de 24 horas…» | Normal: usa una plantilla aprobada (error 131047 de Meta) |
| Al responder: «El token de acceso venció…» | Generaste un token temporal; crea el permanente (paso 6) y actualízalo en *Canales* |
| Un mensaje dice «No se pudo confirmar el envío» | Meta no respondió a tiempo. **No se reenvía solo** (para no duplicarlo al cliente): revisa en tu WhatsApp Manager si salió antes de reintentar |
| Los estados «Entregado/Leído» no aparecen | Revisa la suscripción a `messages`; los reintentos pendientes los procesa el programador cada minuto (sección 5 de `DEPLOY.md`) |
