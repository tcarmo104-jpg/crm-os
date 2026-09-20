# Multimedia del Inbox — archivos, imágenes, video, audio y documentos

Los archivos que llegan por **WhatsApp, Instagram, Messenger y Gmail** se guardan en un almacén **privado** y se ven dentro de
la conversación: imagen con vista ampliada, reproductor de video y de audio, y tarjeta de documento con «Ver» y «Descargar».

> **Estado:** recepción, visualización y descarga están implementadas. **El envío de archivos desde el Inbox aún no** (los
> botones 📎 siguen deshabilitados): es la siguiente fase. Las reglas de envío por canal ya están escritas y probadas en
> `src/lib/media.ts` y se usarán tal cual.

## Cómo funciona

1. Llega el mensaje (webhook de Meta o sincronización de Gmail) → se guarda el mensaje **y** un registro de adjunto «pendiente»
   (`message_attachments`). Si el aviso se repite, el adjunto no se duplica; si algo falló a medias, el reintento lo recupera.
2. Justo después de responder a Meta, el servidor **descarga el archivo** (WhatsApp con el token de la cuenta; Meta por sus
   enlaces temporales; Gmail con `attachments.get`). Lo que no alcance lo toma la tarea programada (cada minuto).
3. **Se verifica por su contenido**, no por su extensión: tipo real, ejecutables, tamaño. Si es peligroso o el tipo no coincide,
   **no se guarda** y la conversación muestra «Archivo bloqueado por seguridad».
4. Se guarda en el bucket privado `inbox-media` (ruta `organización/conversación/adjunto`, sin el nombre del cliente).
5. El navegador nunca recibe una ruta ni un enlace permanente: pide `/api/media/<id>`, el servidor comprueba con la base de datos
   que ese usuario puede ver esa conversación y responde con un **enlace firmado de 2 minutos**.

**Recuperación:** al instalar, los archivos de WhatsApp recibidos en los últimos 7 días que nunca se guardaron quedan pendientes
y se descargan solos; los de más de 7 días ya no existen en Meta y quedan «expirados».

## Qué se recibe y cómo se ve

| Contenido | WhatsApp | Instagram | Messenger | Gmail |
|---|---|---|---|---|
| Imágenes (JPG, PNG, GIF, WebP) | Sí · vista previa + ampliar | Sí | Sí | Sí (adjuntos) |
| Video (MP4, MOV, WebM…) | Sí · reproductor* | Sí* | Sí* | Sí* |
| Audio / nota de voz | Sí · reproductor («Nota de voz») | Sí | Sí | Sí |
| PDF y documentos (Word, Excel, PowerPoint, TXT, CSV, ZIP) | Sí · tarjeta (PDF: «Ver») | Sí (archivo) | Sí | Sí |
| Stickers | Sí | — | — | — |
| Ubicación / contacto compartido | Sí · tarjeta (mapa) | Ubicación | Ubicación | — |

\* Si el navegador no puede reproducir el formato (por ejemplo algunos códecs de video o HEIC), aparece una tarjeta con
«Vista previa no disponible» y el botón **Descargar**; nunca queda un reproductor roto.

Estados que se muestran en lugar del archivo: *Descargando…*, *No se pudo descargar* (se reintenta solo, hasta 6 veces con espera
creciente), *Ya no está disponible* (venció en el canal), *Bloqueado por seguridad* y *Eliminado por antigüedad*.

## Lo que cada API permite ENVIAR (para la fase de envío)

| Canal | Imagen | Video | Audio | Documento |
|---|---|---|---|---|
| WhatsApp | JPG, PNG · 5 MB | MP4, 3GP (H.264 + AAC) · 16 MB | AAC, AMR, MP3, M4A, OGG-Opus · 16 MB | PDF, Word, Excel, PowerPoint, TXT · 100 MB |
| Instagram | PNG, JPG, GIF · 8 MB | MP4, OGG, AVI, MOV, WebM · 25 MB | AAC, M4A, WAV, MP4 · 25 MB | archivo · 25 MB (probar con cuenta real) |
| Messenger | JPG, PNG, GIF · 8 MB | 25 MB | 25 MB | archivo · 25 MB |
| Gmail | casi cualquier tipo seguro, hasta 10 archivos · 25 MB en total | | | |

Fuentes: documentación oficial de Meta (WhatsApp Business Platform, Messenger Platform, Instagram Messaging) y de Gmail API
(consultada el 20/09/2026). WhatsApp **no** acepta GIF, WebP (salvo sticker), HEIC, MOV, WebM, CSV ni ZIP como archivo.

## Seguridad

- **Bucket privado** sin acceso desde el navegador. Además la migración crea una política *restrictiva* que impide a cualquier
  usuario (o anónimo) leer o escribir `inbox-media`, aunque en tu proyecto exista alguna política permisiva de Storage.
- **Nunca se confía en la extensión ni en el tipo declarado**: se lee el contenido (firmas de archivo). Se bloquean ejecutables
  (Windows, Linux, macOS), scripts, HTML y SVG (que pueden llevar código), y las dobles extensiones (`factura.pdf.exe`).
- **Solo se descarga de servidores de Meta** (https, dominios de Meta) y cada redirección se valida: un mensaje falso no puede
  hacer que el servidor visite direcciones internas.
- **Nombres de archivo limpios** (sin rutas, comillas, saltos de línea ni marcas de derecha a izquierda) para pantalla y cabeceras.
- **Aislamiento**: un adjunto se ve solo si se ve su conversación (organización y alcance del usuario, con la seguridad de la base
  de datos). Otra organización recibe «no encontrado», sin pistas de que el archivo existe.
- **Conservación: 12 meses.** Pasado el plazo se borra el archivo y el adjunto queda «eliminado por antigüedad»; el mensaje se conserva.

## Después de instalar: 2 comprobaciones en Supabase

1. **Storage → Buckets:** debe existir `inbox-media` marcado como **privado** (límite 100 MB). Si el instalador avisó de que no pudo
   crearlo, créalo a mano: privado, 100 MB.
2. **Storage → Policies:** debe aparecer «inbox-media: solo el servidor» (restrictiva). Si no está, avísame.

> El límite global de tamaño de subida de tu plan de Supabase puede ser menor que 100 MB; los archivos más grandes se marcan
> «No se pudo descargar» en lugar de guardarse.

## Límites conocidos

- Sin miniaturas generadas (se usa la imagen original) ni vista previa de PDF dentro del Inbox (se abre en otra pestaña).
- HEIC y algunos audios/videos (por ejemplo OGG/Opus en Safari) pueden no reproducirse en todos los navegadores: se ofrece descarga.
- Los enlaces de Facebook/Instagram son temporales: si el mensaje no se procesó a tiempo, el archivo queda «ya no disponible».
- Los correos enviados directamente desde Gmail no se importan; solo los recibidos.
