# Conexiones — WhatsApp, Facebook Messenger, Instagram y Gmail

Todo lo que escriban tus clientes por estos cuatro canales llega al **mismo Inbox**, y desde ahí respondes por el canal
correspondiente. Cada conversación queda unida a su **cliente**: si la misma persona vuelve a escribir, continúa su
conversación (no se crea otro cliente ni otro lead).

Se gestiona en **Configuración → Conexiones** (solo administradores).

## 1. Variables de entorno (Vercel → Settings → Environment Variables)

| Variable | Para qué | Dónde se obtiene |
|---|---|---|
| `META_APP_SECRET` | firmar/verificar los mensajes de Meta (ya la tienes) | Meta → tu app → Configuración → Básica |
| `META_VERIFY_TOKEN` | verificar el webhook (ya la tienes) | tú la inventas |
| **`META_APP_ID`** *(nueva)* | iniciar sesión con Meta (Facebook/Instagram) | Meta → tu app → Configuración → Básica → «Identificador de la app» |
| **`GOOGLE_CLIENT_ID`** *(nueva)* | iniciar sesión con Google (Gmail) | Google Cloud → Credenciales |
| **`GOOGLE_CLIENT_SECRET`** *(nueva)* | ídem | Google Cloud → Credenciales |
| `CONNECTIONS_ENCRYPTION_KEY` *(opcional)* | cifrar los tokens en la base de datos | texto aleatorio de 32+ caracteres |
| `NEXT_PUBLIC_SITE_URL` | dirección pública (debe ser `https://…`) | ya la tienes |

Después de agregar variables, en Vercel pulsa **Redeploy**. **Cuidado con `CONNECTIONS_ENCRYPTION_KEY`:** si la defines y
luego la pierdes o la cambias, los tokens guardados con ella dejan de poder leerse y tendrás que reconectar las cuentas.

## 2. Facebook Messenger e Instagram (Meta)

Se conectan **con un solo inicio de sesión**: el botón «Conectar con Meta» te lleva a Facebook, autorizas, eliges qué
páginas (y cuentas de Instagram asociadas) quieres y listo. No hay que copiar tokens.

**Requisitos**
- Ser **administrador** de la página de Facebook.
- Para Instagram: la cuenta debe ser **profesional (Business/Creator)** y estar **vinculada a la página** de Facebook.
- Una app de Meta (la misma que usas para WhatsApp sirve) con los productos **Inicio de sesión con Facebook**,
  **Messenger** e **Instagram**.

**En Meta → tu app**
1. *Inicio de sesión con Facebook → Configuración → URI de redirección de OAuth válidos*: pega  
   `https://TU-APP.vercel.app/api/connections/meta/callback`  
   (la ves también en Conexiones → «Datos para configurar Meta»).
2. *Webhooks*: usa la **misma URL y el mismo token de verificación** que WhatsApp  
   (`https://TU-APP.vercel.app/api/webhooks/meta`).
   - Objeto **Page**: suscribe `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads`.
   - Objeto **Instagram**: suscribe `messages`.
3. *Permisos que se piden al iniciar sesión* (solo los necesarios): `pages_show_list`, `pages_messaging`,
   `pages_manage_metadata`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_messages`, `business_management`.

**Mientras la app está en modo «Desarrollo»** solo funcionan personas con un rol en la app (administradores,
desarrolladores, probadores). Para probar, agrega a quien vaya a escribir como *Probador* (Meta → Roles). Para recibir
mensajes de cualquier cliente, la app debe pasar a modo *Activo* y Meta debe aprobar los permisos (Revisión de la app).

**Regla de las 24 horas:** en Messenger e Instagram solo puedes responder con texto libre dentro de las 24 h siguientes al
último mensaje del cliente. Pasado ese plazo el Inbox lo avisa y espera a que él escriba de nuevo.

## 3. Gmail (Google)

**En Google Cloud Console** (console.cloud.google.com)
1. Crea un proyecto y habilita la **Gmail API**.
2. *Pantalla de consentimiento de OAuth*: tipo **Externo**; agrega tu correo como **usuario de prueba**.
3. *Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web*. En **URI de redireccionamiento
   autorizados** pega `https://TU-APP.vercel.app/api/connections/google/callback`.
4. Copia el *ID de cliente* y el *Secreto* a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Vercel.

**Permisos que se piden:** leer y enviar correo de Gmail (`gmail.readonly` y `gmail.send`). Nunca se guarda tu contraseña,
y **no se pide** permiso para borrar ni modificar correos.

**Importante sobre las pruebas:** mientras la app de Google esté en modo **«Prueba»**, Google **vence el acceso cada 7
días** y tendrás que pulsar «Volver a autorizar». Para uso permanente hay que **publicar** la app (y, como pide permisos
de Gmail, pasar la verificación de Google).

**Cómo funciona la recepción:** Gmail no avisa al CRM; el CRM revisa la bandeja cada vez que corre la tarea programada
(la misma de `/api/cron/dispatch-events`, recomendada **cada minuto**; ver DEPLOY.md §5) y con el botón **Sincronizar**.
Solo trae **correos directos de personas**: descarta promociones, redes, notificaciones, boletines, respuestas
automáticas, «no-reply» y lo que envías tú. Cada correo se une al cliente que tenga ese **correo electrónico**; si no
existe, se crea. Las respuestas salen desde tu Gmail, en el mismo hilo, con «Re: asunto».

## 4. Estados y qué hacer

| Estado | Significa | Qué hacer |
|---|---|---|
| **Conectado** | todo funciona | nada |
| **Pendiente** | falta verificar | pulsa **Verificar** |
| **Requiere autorización** | faltan permisos o el acceso se revocó | «Volver a autorizar» (o guarda un token válido en WhatsApp) |
| **Token expirado** | el acceso venció | «Volver a autorizar» |
| **Error de conexión** | Meta/Google no respondió | se reintenta solo; si sigue, pulsa **Verificar** |
| **Webhook no configurado** | Meta no envía mensajes a tu CRM | revisa la URL y los campos suscritos (sección 2) |
| **Desconectado** | lo desconectaste | «Reconectar». **El historial se conserva** |

El detalle técnico de cada verificación está en **Configurar → Registro técnico** (solo administradores; nunca contiene
credenciales).

## 5. Seguridad

- Los tokens **nunca** se muestran ni salen del servidor: ni en la pantalla, ni en el HTML, ni en URLs, ni en registros.
- Las credenciales las ve y usa solo el servidor; un usuario normal no puede leerlas ni cambiarlas.
- El inicio de sesión con Meta/Google lleva un `state` firmado, ligado al administrador, a su organización y a su
  navegador, que caduca en 10 minutos.
- Al **desconectar** se borra el acceso guardado; las conversaciones y los mensajes se conservan.
