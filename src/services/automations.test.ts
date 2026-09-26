import { describe, expect, it, vi } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as automations from './automations';

function fakeDb() {
  const calls: { fn: string; args: unknown }[] = [];
  const db = { rpc: vi.fn(async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: 'rule-1', error: null }; }) } as unknown as ServerSupabase;
  return { db, calls };
}
const ORG = '22222222-2222-4222-8222-222222222222';
const rejects = async (p: Promise<unknown>, match?: RegExp) => { const e = await p.then(() => null, (e: unknown) => e); expect(e).toBeInstanceOf(UserFacingError); if (match) expect((e as Error).message).toMatch(match); };

describe('createRule: valida antes de tocar la base de datos', () => {
  it('arma disparador, condiciones y acciones tal como los espera create_automation_rule', async () => {
    const { db, calls } = fakeDb();
    await automations.createRule(db, ORG, {
      name: '  Etiquetar feria  ', trigger: 'lead.created',
      conditions: [{ field: 'source', op: 'eq', value: 'feria' }],
      actions: [{ type: 'add_tag', name: 'Feria' }],
    });
    expect(calls[0]).toEqual({ fn: 'create_automation_rule', args: {
      p_org: ORG, p_name: 'Etiquetar feria', p_trigger: 'lead.created',
      p_conditions: [{ field: 'source', op: 'eq', value: 'feria' }], p_actions: [{ type: 'add_tag', name: 'Feria' }],
    } });
  });
  it('rechaza sin nombre, sin acciones, o con un disparador desconocido, sin tocar la base de datos', async () => {
    const { db, calls } = fakeDb();
    await rejects(automations.createRule(db, ORG, { name: '', trigger: 'lead.created', actions: [{ type: 'add_tag', name: 'x' }] }));
    await rejects(automations.createRule(db, ORG, { name: 'X', trigger: 'lead.created', actions: [] }), /al menos una acción/);
    await rejects(automations.createRule(db, ORG, { name: 'X', trigger: 'volar', actions: [{ type: 'add_tag', name: 'x' }] }));
    expect(calls).toHaveLength(0);
  });
  it('rechaza una acción sin sus campos obligatorios (crear tarea sin título, etiqueta sin nombre)', async () => {
    const { db } = fakeDb();
    await rejects(automations.createRule(db, ORG, { name: 'X', trigger: 'lead.created', actions: [{ type: 'create_task' }] }), /título/);
    await rejects(automations.createRule(db, ORG, { name: 'X', trigger: 'lead.created', actions: [{ type: 'add_tag' }] }), /etiqueta/);
    await rejects(automations.createRule(db, ORG, { name: 'X', trigger: 'lead.created', actions: [{ type: 'assign_owner' }] }), /asignar/);
    await rejects(automations.createRule(db, ORG, { name: 'X', trigger: 'lead.created', actions: [{ type: 'enroll_sequence' }] }), /secuencia/);
  });
  it('un tipo de acción desconocido se rechaza', async () => {
    const { db } = fakeDb();
    await rejects(automations.createRule(db, ORG, { name: 'X', trigger: 'lead.created', actions: [{ type: 'volar' }] }));
  });
  it('sin condiciones, se manda una lista vacía (la regla aplica siempre)', async () => {
    const { db, calls } = fakeDb();
    await automations.createRule(db, ORG, { name: 'X', trigger: 'opportunity.won', actions: [{ type: 'add_tag', name: 'x' }] });
    expect((calls[0]!.args as { p_conditions: unknown[] }).p_conditions).toEqual([]);
  });
});
