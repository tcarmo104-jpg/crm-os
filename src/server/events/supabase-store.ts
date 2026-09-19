import 'server-only';
import { createAdminClient } from '@/server/supabase-admin';
import type { DomainEvent, EventStore } from './dispatcher';

/** Implementación del EventStore sobre las funciones worker_* de Postgres (solo service_role). */
export function createSupabaseEventStore(): EventStore {
  const db = createAdminClient();
  return {
    async claim(limit) {
      const { data, error } = await db.rpc('worker_claim_events', { p_limit: limit });
      if (error) throw new Error(`claim: ${error.message}`);
      return (data ?? []) as DomainEvent[];
    },
    async complete(id) {
      const { error } = await db.rpc('worker_complete_event', { p_id: id });
      if (error) throw new Error(`complete: ${error.message}`);
    },
    async fail(id, message) {
      const { error } = await db.rpc('worker_fail_event', { p_id: id, p_error: message });
      if (error) throw new Error(`fail: ${error.message}`);
    },
  };
}
