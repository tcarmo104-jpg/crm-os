import type { HandlerRegistry } from './dispatcher';
import { automationHandlers } from './automation-handler';

/**
 * Registro de handlers. En la Fase 1b solo había observabilidad.
 * Fase 8 suma Automatizaciones (reglas «cuando ocurre X y se cumple Y, entonces Z»), sin tocar el
 * dispatcher: cada disparador soportado apunta al mismo handler, que ya sabe encontrar y ejecutar
 * las reglas activas de la organización del evento.
 * Las siguientes fases registran aquí, de la misma forma:
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
  ...automationHandlers,
};
