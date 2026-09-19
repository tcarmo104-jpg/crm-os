import { describe, expect, it, vi } from 'vitest';
import { dispatchEvents, handlersFor, type DomainEvent, type EventStore } from './dispatcher';

const ev = (id: string, type: string): DomainEvent => ({
  id, org_id: 'o1', type, entity_type: null, entity_id: null, customer_id: null,
  payload: {}, actor_id: null, occurred_at: new Date().toISOString(), attempts: 1,
});

function fakeStore(batches: DomainEvent[][]) {
  const queue = [...batches];
  const store = {
    claim: vi.fn(async () => queue.shift() ?? []),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  } satisfies EventStore;
  return store;
}

describe('handlersFor', () => {
  it('combina handlers exactos, por prefijo y globales', () => {
    const a = async () => {}, b = async () => {}, c = async () => {};
    const reg = { 'quote.accepted': [a], 'quote.*': [b], '*': [c] };
    expect(handlersFor(reg, 'quote.accepted')).toEqual([a, b, c]);
    expect(handlersFor(reg, 'quote.sent')).toEqual([b, c]);
    expect(handlersFor(reg, 'lead.created')).toEqual([c]);
  });
});

describe('dispatchEvents', () => {
  it('ejecuta handlers y completa los eventos', async () => {
    const store = fakeStore([[ev('1', 'lead.created'), ev('2', 'lead.created')]]);
    const handler = vi.fn(async () => {});
    const s = await dispatchEvents(store, { 'lead.created': [handler] });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.complete).toHaveBeenCalledTimes(2);
    expect(store.fail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ claimed: 2, processed: 2, failed: 0, unhandled: 0 });
  });

  it('un handler que falla marca el evento como fallido y sigue con los demás', async () => {
    const store = fakeStore([[ev('1', 'a.b'), ev('2', 'a.c')]]);
    const registry = {
      'a.b': [async () => { throw new Error('boom'); }],
      'a.c': [async () => {}],
    };
    const s = await dispatchEvents(store, registry);
    expect(store.fail).toHaveBeenCalledWith('1', 'boom');
    expect(store.complete).toHaveBeenCalledWith('2');
    expect(store.complete).not.toHaveBeenCalledWith('1');
    expect(s).toMatchObject({ processed: 1, failed: 1 });
  });

  it('eventos sin handler se completan y se cuentan como "unhandled"', async () => {
    const store = fakeStore([[ev('1', 'x.y')]]);
    const s = await dispatchEvents(store, {});
    expect(store.complete).toHaveBeenCalledWith('1');
    expect(s.unhandled).toBe(1);
  });

  it('si un handler falla a mitad, no se completa aunque otros handlers hayan corrido', async () => {
    const store = fakeStore([[ev('1', 'a.b')]]);
    const first = vi.fn(async () => {});
    const registry = { 'a.b': [first, async () => { throw new Error('segundo falla'); }] };
    await dispatchEvents(store, registry);
    expect(first).toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith('1', 'segundo falla');
  });

  it('continúa con más lotes solo si el lote anterior venía lleno, y respeta maxBatches', async () => {
    const full = () => [ev('a', 't.t'), ev('b', 't.t')];
    const store = fakeStore([full(), full(), full(), full()]);
    const s = await dispatchEvents(store, {}, { limit: 2, maxBatches: 3 });
    expect(s.batches).toBe(3);
    expect(store.claim).toHaveBeenCalledTimes(3);

    const store2 = fakeStore([[ev('a', 't.t')]]);
    await dispatchEvents(store2, {}, { limit: 2, maxBatches: 3 });
    expect(store2.claim).toHaveBeenCalledTimes(1);
  });

  it('con la cola vacía no hace nada', async () => {
    const store = fakeStore([]);
    const s = await dispatchEvents(store, {});
    expect(s).toEqual({ claimed: 0, processed: 0, unhandled: 0, failed: 0, batches: 0 });
  });
});
