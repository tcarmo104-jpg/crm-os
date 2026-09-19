import type { HandlerRegistry } from './dispatcher';

/**
 * Registro de handlers. En la Fase 1b solo hay observabilidad.
 * Las siguientes fases registran aquí, sin tocar el dispatcher:
 *   'customer.*'     → timeline, scoring
 *   'quote.accepted' → crear venta, recompra
 *   'message.received' → clasificación de intención (IA)
 *   'invitation.created' → envío de email (cuando haya proveedor de correo)
 */
export const registry: HandlerRegistry = {
  '*': [
    async (event) => {
      // Log estructurado (una línea JSON) para métricas y depuración en Vercel/Supabase.
      console.log(
        JSON.stringify({
          msg: 'domain_event',
          id: event.id,
          type: event.type,
          org_id: event.org_id,
          attempts: event.attempts,
        }),
      );
    },
  ],
};
