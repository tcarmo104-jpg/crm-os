# Que lleguen los mensajes de WhatsApp al CRM — guía corta (sin Vercel)

Todo se hace **dentro del CRM**: no hay que entrar a Vercel ni tocar variables.

## Por qué NO es por número ni por cuenta
La «clave secreta» y el «token de verificación» son de la **aplicación de Meta** (la «app» de developers.facebook.com), no de cada número de WhatsApp:

| Situación | Qué se hace |
|---|---|
| Tienes **10 números o cuentas de WhatsApp de la misma app de Meta** | Nada nuevo: cada número solo necesita sus datos (ID del número, ID de la cuenta, token), que se escriben en el CRM |
| **Cada empresa tiene SU propia app de Meta** | Cada empresa pega el Identificador y la Clave secreta de SU app en su CRM (una sola vez). Los avisos de una empresa nunca pueden tocar los canales de otra |

## Los 3 pasos (una sola vez por aplicación de Meta)
1. **Copia dos datos en Meta:** developers.facebook.com → tu app → **Configuración de la app → Básica**: el *Identificador de la app* y, con el botón *Mostrar*, la *Clave secreta de la app*.
2. **Pégalos en el CRM:** **Configuración → Conexiones** → panel **«Tu aplicación de Meta»** → **Guardar y conectar**.
3. **Conecta tu número:** en la tarjeta de WhatsApp, **Conectar** (ID del número, ID de la cuenta y token).

Al pulsar «Guardar y conectar» el CRM: comprueba con Meta que los datos son de verdad, los guarda en el servidor (nunca se vuelven a mostrar), crea solo el token de verificación y
**configura el webhook en Meta** (la dirección la detecta sola por donde abriste el CRM). Sin copiar direcciones.

## Si algo no llega
Abre **Configuración → Conexiones → Configurar** (tu número): el panel **«¿Por qué no llegan mis mensajes?»** dice en UNA frase qué falla y qué hacer.

| El panel dice | Qué hacer |
|---|---|
| *Falta conectar tu aplicación de Meta al CRM* | Paso 2 de arriba |
| *Meta todavía no sabe a dónde enviar tus mensajes* | Botón **Configurar el webhook en Meta automáticamente** |
| *Meta intentó conectarse, pero el token de verificación no coincide* | El mismo botón |
| *Meta SÍ está enviando mensajes, pero el CRM los rechaza: la clave secreta no coincide* | Vuelve a copiar la Clave secreta (de la MISMA app) y pégala en «Tu aplicación de Meta» |
| *El CRM se abrió desde una dirección local o sin https* | Abre el CRM desde su dirección pública (https://…) |
| *El token de acceso venció* | En Meta genera un token PERMANENTE y guárdalo en «Credenciales» |
| *Todo funciona* | Nada |

«Ejecutar diagnóstico completo» consulta directamente a Meta (webhook registrado, si tu token es temporal y cuándo vence).

## Prueba con el número de prueba de Meta
1. Meta → tu app → **Configuración de la API** → en **«Para»**, agrega tu celular y confírmalo con el código que te llega por WhatsApp.
2. Pulsa **Enviar mensaje** y **responde** ese mensaje desde tu celular: esa respuesta debe aparecer en el Inbox.

## Para quien instala el sistema
Las variables `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_APP_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `NEXT_PUBLIC_SITE_URL` **ya no son necesarias**. Si existen siguen
funcionando como respaldo (una aplicación «de la plataforma» para las organizaciones que no tienen la suya); puedes borrarlas cuando cada organización haya conectado la suya.
Lo único opcional que queda en Vercel es `CONNECTIONS_ENCRYPTION_KEY` (32+ caracteres): si la defines, además cifra los tokens y claves guardados en la base de datos.
Gmail funciona igual: «Tu aplicación de Google» en Conexiones.
