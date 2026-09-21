# Publicar tu app de Meta (modo «Activo / Live») — qué pide Meta y dónde ponerlo

Meta solo pide estos datos cuando intentas **publicar** la app o **enviarla a revisión**. Mientras pruebas con tu propia cuenta puedes seguir en modo desarrollo.
Se llenan en developers.facebook.com → tu app → **Configuración de la app → Básica**.

| Campo de Meta | Qué poner |
|---|---|
| **Icono de la aplicación (1024 × 1024)** | El archivo `icono-app-1024.png` (o tu logo cuadrado de 1024 × 1024) |
| **URL de la Política de privacidad** | `https://TU-DOMINIO/privacidad` (página pública del CRM) |
| **URL de eliminación de datos** (si Meta la pide) | `https://TU-DOMINIO/eliminacion-de-datos` |
| **Categoría** | «Empresas y páginas» (Business and pages) o la más parecida |
| **Dominios de la aplicación** | `TU-DOMINIO` (sin `https://` ni `/`) |

Después de llenar, baja y pulsa **Guardar cambios**.

Para que los clientes reales puedan escribirte por **Instagram y Messenger**, además de estar «Activo» Meta exige aprobar los permisos de mensajería
(«Revisión de la app») y, según el caso, la verificación de la empresa. Es un trámite de Meta, no del CRM.

Para poner tu correo de contacto en las páginas legales, edita `contactEmail` en `src/lib/legal.ts`.
