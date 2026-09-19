/**
 * Dispatcher de eventos de dominio (outbox).
 *
 * Diseño para funciones serverless: cada ejecución reclama lotes CORTOS de la cola,
 * ejecuta los handlers y termina. La cola vive en Postgres (SKIP LOCKED), por lo que
 * varias ejecuciones simultáneas no procesan el mismo evento.
 *
 * Garantía: AL MENOS UNA VEZ. Si un handler falla, el evento se reintenta con backoff
 * exponencial y, tras varios intentos, pasa a dead-letter. Por eso los handlers deben ser idempotentes.
 */
export interface DomainEvent {
  id: string;
  org_id: string;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  customer_id: string | null;
  payload: Record<string, unknown>;
  actor_id: string | null;
  occurred_at: string;
  attempts: number;
}

export interface EventStore {
  claim(limit: number): Promise<DomainEvent[]>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}

export type EventHandler = (event: DomainEvent) => Promise<void>;
/** Claves: tipo exacto ("quote.accepted"), prefijo ("quote.*") o "*" para todos. */
export type HandlerRegistry = Record<string, EventHandler[]>;

export interface DispatchSummary {
  claimed: number;
  processed: number;
  unhandled: number;
  failed: number;
  batches: number;
}

export function handlersFor(registry: HandlerRegistry, type: string): EventHandler[] {
  const out: EventHandler[] = [];
  const prefix = type.split('.')[0];
  for (const key of [type, `${prefix}.*`, '*']) {
    const list = registry[key];
    if (list) out.push(...list);
  }
  return out;
}

export async function dispatchEvents(
  store: EventStore,
  registry: HandlerRegistry,
  opts: { limit?: number; maxBatches?: number } = {},
): Promise<DispatchSummary> {
  const limit = opts.limit ?? 50;
  const maxBatches = opts.maxBatches ?? 3;
  const summary: DispatchSummary = { claimed: 0, processed: 0, unhandled: 0, failed: 0, batches: 0 };

  for (let b = 0; b < maxBatches; b++) {
    const events = await store.claim(limit);
    if (events.length === 0) break;
    summary.batches++;
    summary.claimed += events.length;

    for (const ev of events) {
      const handlers = handlersFor(registry, ev.type);
      try {
        for (const h of handlers) await h(ev);
        await store.complete(ev.id);
        if (handlers.length === 0) summary.unhandled++;
        else summary.processed++;
      } catch (e) {
        summary.failed++;
        await store.fail(ev.id, e instanceof Error ? e.message : String(e));
      }
    }
    if (events.length < limit) break;
  }
  return summary;
}
