import { describe, expect, it, vi } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as sequences from './sequences';

function fakeDb() {
  const calls: { fn: string; args: unknown }[] = [];
  const db = { rpc: vi.fn(async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: 'seq-1', error: null }; }) } as unknown as ServerSupabase;
  return { db, calls };
}
const ORG = '22222222-2222-4222-8222-222222222222';
const rejects = async (p: Promise<unknown>, match?: RegExp) => { const e = await p.then(() => null, (e: unknown) => e); expect(e).toBeInstanceOf(UserFacingError); if (match) expect((e as Error).message).toMatch(match); };

describe('createSequence: valida antes de tocar la base de datos', () => {
  it('arma los pasos con sus valores por defecto (tipo, prioridad) tal como los espera create_sequence', async () => {
    const { db, calls } = fakeDb();
    await sequences.createSequence(db, ORG, { name: '  Bienvenida  ', steps: [{ title: 'Llamar', offsetDays: '0' }, { title: 'WhatsApp', type: 'whatsapp', offsetDays: 2, priority: 'high' }] });
    expect(calls[0]).toEqual({ fn: 'create_sequence', args: { p_org: ORG, p_name: 'Bienvenida', p_description: null, p_steps: [
      { title: 'Llamar', type: 'follow_up', offsetDays: 0, priority: 'normal', description: undefined },
      { title: 'WhatsApp', type: 'whatsapp', offsetDays: 2, priority: 'high', description: undefined },
    ] } });
  });
  it('rechaza sin nombre, sin pasos, o con un paso sin título, sin tocar la base de datos', async () => {
    const { db, calls } = fakeDb();
    await rejects(sequences.createSequence(db, ORG, { name: '', steps: [{ title: 'x', offsetDays: 0 }] }));
    await rejects(sequences.createSequence(db, ORG, { name: 'X', steps: [] }), /al menos un paso/);
    await rejects(sequences.createSequence(db, ORG, { name: 'X', steps: [{ title: '', offsetDays: 0 }] }));
    expect(calls).toHaveLength(0);
  });
  it('rechaza días negativos o un tipo de paso desconocido', async () => {
    const { db } = fakeDb();
    await rejects(sequences.createSequence(db, ORG, { name: 'X', steps: [{ title: 'x', offsetDays: -1 }] }));
    await rejects(sequences.createSequence(db, ORG, { name: 'X', steps: [{ title: 'x', offsetDays: 0, type: 'volar' }] }));
  });
});
