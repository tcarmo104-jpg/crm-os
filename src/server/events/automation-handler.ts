import 'server-only';
import { createAdminClient } from '@/server/supabase-admin';
import type { DomainEvent, EventHandler } from './dispatcher';
import { AUTOMATION_TRIGGERS } from '@/lib/automations';

/**
 * Ejecuta las reglas de Automatizaciones activas de la organización que coincidan con este evento.
 * `run_automation_rule` ya es idempotente (una llave única por regla+evento), así que reintentar este
 * handler tras una falla parcial es seguro: las reglas ya ejecutadas no se repiten.
 */
export const runAutomations: EventHandler = async (event: DomainEvent) => {
  const db = createAdminClient();
  const { data: rules, error } = await db
    .from('automation_rules')
    .select('id')
    .eq('org_id', event.org_id)
    .eq('trigger', event.type)
    .eq('is_active', true);
  if (error) throw new Error(`automation_rules: ${error.message}`);
  for (const rule of rules ?? []) {
    const { error: runError } = await db.rpc('run_automation_rule', {
      p_rule_id: rule.id,
      p_event_id: event.id,
      p_event: { customer_id: event.customer_id, entity_type: event.entity_type, entity_id: event.entity_id, payload: event.payload },
    });
    if (runError) throw new Error(`run_automation_rule: ${runError.message}`);
  }
};

/** Un registro por cada disparador soportado, listo para sumarse al `registry` del despachador. */
export const automationHandlers: Record<string, EventHandler[]> = Object.fromEntries(
  AUTOMATION_TRIGGERS.map((trigger) => [trigger, [runAutomations]]),
);
