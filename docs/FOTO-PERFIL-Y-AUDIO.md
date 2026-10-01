# Foto de perfil y notas de voz en el Inbox — qué se construyó

## Foto de perfil del contacto
- **Facebook e Instagram**: se extendió la llamada que el CRM YA hacía a Meta para pedir el nombre del
  contacto (al abrir una conversación nueva) para que pida también `profile_pic` en la misma petición — sin
  gastar una llamada extra a la API.
- **WhatsApp**: su API no expone fotos de perfil por ningún lado (limitación de Meta, no del CRM). Ese canal
  sigue mostrando las iniciales sobre un color estable, como siempre.
- Solo se guarda una foto cuando la URL viene de un dominio real de Meta (`fbcdn.net`, `cdninstagram.com`,
  `fbsbx.com`); cualquier otra cosa se ignora en silencio. Una vez guardada, no se vuelve a pisar sola.
- Si la imagen no carga (por ejemplo, si Meta la expira), se cae de vuelta a las iniciales, sin parpadeo.

## Enviar notas de voz desde el CRM
- Toda la validación de audio (formatos y tamaños por canal) **ya existía** en el sistema; lo que faltaba era
  la manera de grabar. Se agregó un botón de micrófono en el redactor del Inbox que graba con el micrófono
  del navegador y reutiliza exactamente el mismo camino de subida y envío que ya usaba cualquier archivo
  adjuntado (mismas reglas, mismas pruebas).
- Lo enviado así queda marcado como «nota de voz» (antes solo se marcaba lo que WhatsApp mandaba hacia el
  CRM; lo que el propio agente enviaba nunca se marcaba).

### Una limitación real de los navegadores (no es un error del CRM)
Cada navegador graba audio en un formato distinto, y no todos coinciden con lo que cada canal acepta:

| Navegador | Formato que graba | ¿WhatsApp/Messenger/Instagram lo aceptan? |
|---|---|---|
| Firefox | `audio/ogg` | Sí |
| Chrome, Edge | `audio/webm` | No |
| Safari (reciente) | `audio/mp4` | Sí |

Si el navegador graba en un formato que ese canal no acepta, el CRM **no finge que se envió**: muestra un
aviso claro pidiendo grabar desde otro navegador (Firefox funciona en cualquier canal) o adjuntar una nota
de voz ya grabada como archivo. Gmail acepta cualquiera de los tres formatos, así que ahí siempre funciona.

## Verificación
- 6 pruebas SQL nuevas (foto de perfil y notas de voz), 2 mutaciones de seguridad, ambas detectadas.
- 4 pruebas unitarias nuevas para la llamada combinada nombre+foto.
- 513 pruebas unitarias y 270 de integración en total, todas en verde.
- 9 comprobaciones en navegador real: la foto aparece en la lista, el encabezado y el panel de detalle;
  WhatsApp sigue con iniciales; el botón de grabar aparece y está deshabilitado cuando corresponde (ventana
  de respuesta cerrada); y se confirmó que el manejo de error cuando el navegador niega el micrófono
  funciona correctamente. No se pudo grabar un audio real de principio a fin en el entorno de pruebas (el
  navegador headless usado para verificar no tiene micrófono, ni siquiera simulado) — el camino de subida y
  envío que usa después es el mismo que ya está probado para cualquier archivo adjuntado.

## Corrección (migración 0030): conversaciones que ya existían antes de esta función

**Un cliente real lo notó** al probarlo: las conversaciones de Facebook/Instagram que ya existían antes de
que esta función se instalara nunca recibían su foto, porque el código solo la pedía la primera vez que se
CREABA una conversación. Las que ya existían jamás volvían a pasar por ese camino.

Se corrigió sin ninguna consulta extra: `ingest_channel_message` (que ya carga el cliente en memoria en cada
mensaje) ahora también avisa si a ese cliente le falta la foto, sin importar si la conversación es nueva o
no. El siguiente mensaje que llegue de un contacto sin foto — el que sea, no hace falta que sea el primero —
la vuelve a pedir. Una vez guardada, dejan de pedirse llamadas de más: se sigue respetando que nunca se pisa
una foto que ya existe.

Verificado con 4 pruebas SQL nuevas y una mutación de seguridad (confirma que, si alguien accidentalmente
dejara de pedir la foto en este caso, la prueba lo detecta).
