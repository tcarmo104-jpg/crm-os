import { describe, expect, it, vi } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as sales from './sales';

/** Cliente falso que registra las llamadas RPC/update para comprobar qué llegaría a la BD. */
function fakeDb() {
  const calls: { fn: string; args: unknown }[] = [];
  const db = {
    rpc: vi.fn(async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: 'new-id', error: null }; }),
    from: () => ({ update: (f: unknown) => ({ eq: () => ({ select: () => ({ single: async () => { calls.push({ fn: 'update', args: f }); return { data: {}, error: null }; } }) }) }) }),
  } as unknown as ServerSupabase;
  return { db, calls };
}
const ID = '11111111-1111-4111-8111-111111111111';
const rejectsUser = async (p: Promise<unknown>) => { await expect(p).rejects.toBeInstanceOf(UserFacingError); };

describe('createOpportunity', () => {
  it('interpreta el monto escrito por una persona y manda null donde no hay dato', async () => {
    const { db, calls } = fakeDb();
    await sales.createOpportunity(db, { customerId: ID, title: '  Plan A ', amount: '$ 1.500.000', expectedClose: '', productInterest: '' });
    expect(calls[0]).toEqual({ fn: 'create_opportunity', args: {
      p_customer: ID, p_title: 'Plan A', p_amount: 1500000, p_pipeline: null, p_expected_close: null, p_product_interest: null } });
  });
  it('rechaza monto inválido, título vacío y cliente inválido sin llamar a la BD', async () => {
    const { db, calls } = fakeDb();
    await rejectsUser(sales.createOpportunity(db, { customerId: ID, title: 'X', amount: 'mucho' }));
    await rejectsUser(sales.createOpportunity(db, { customerId: ID, title: '  ', amount: '10' }));
    await rejectsUser(sales.createOpportunity(db, { customerId: 'no-uuid', title: 'X', amount: '10' }));
    await rejectsUser(sales.createOpportunity(db, { customerId: ID, title: 'X', amount: '10', expectedClose: '31/12/2026' }));
    expect(calls).toHaveLength(0);
  });
  it('sin monto es 0', async () => {
    const { db, calls } = fakeDb();
    await sales.createOpportunity(db, { customerId: ID, title: 'X', amount: '' });
    expect((calls[0]!.args as { p_amount: number }).p_amount).toBe(0);
  });
});

describe('tareas', () => {
  it('convierte la fecha escrita a UTC usando la zona de la organización', async () => {
    const { db, calls } = fakeDb();
    await sales.createTask(db, ID, 'America/Bogota', { title: 'Llamar', type: 'call', priority: 'high', due: '2026-09-20T09:30', customerId: ID });
    expect(calls[0]!.args).toMatchObject({ p_due: '2026-09-20T14:30:00.000Z', p_type: 'call', p_priority: 'high', p_customer: ID, p_opportunity: null });
  });
  it('sin fecha es null; fecha imposible se rechaza', async () => {
    const { db, calls } = fakeDb();
    await sales.createTask(db, ID, 'America/Bogota', { title: 'Sin fecha' });
    expect(calls[0]!.args).toMatchObject({ p_due: null, p_type: 'follow_up', p_priority: 'normal' });
    await rejectsUser(sales.createTask(db, ID, 'America/Bogota', { title: 'X', due: '2026-02-31T10:00' }));
    await rejectsUser(sales.createTask(db, ID, 'America/Bogota', { title: 'X', type: 'telepatia' }));
  });
});

describe('actividades y leads', () => {
  it('llamadas, WhatsApp y correos exigen dirección; notas y reuniones la ignoran', async () => {
    const { db, calls } = fakeDb();
    await rejectsUser(sales.logActivity(db, { customerId: ID, type: 'call', summary: 'Habló' }));
    await sales.logActivity(db, { customerId: ID, type: 'note', summary: 'Prefiere tardes', direction: 'inbound' });
    expect(calls[0]!.args).toMatchObject({ p_type: 'note', p_direction: null });
    await sales.logActivity(db, { customerId: ID, type: 'call', summary: 'Habló', direction: 'outbound' });
    expect(calls[1]!.args).toMatchObject({ p_direction: 'outbound' });
  });
  it('descartar un lead exige motivo; "converted" no se acepta por esta vía', async () => {
    const { db, calls } = fakeDb();
    await rejectsUser(sales.changeLeadStatus(db, ID, 'disqualified', ' '));
    await rejectsUser(sales.changeLeadStatus(db, ID, 'converted'));
    await sales.changeLeadStatus(db, ID, 'disqualified', 'Sin presupuesto');
    expect(calls[0]).toEqual({ fn: 'set_lead_status', args: { p_lead: ID, p_to: 'disqualified', p_reason: 'Sin presupuesto' } });
  });
});

describe('etapas', () => {
  it('ganada = 100 %, perdida = 0 %, abierta no puede llegar a 100', async () => {
    const chain = { insert: vi.fn(() => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) })) };
    const db = { from: () => chain } as unknown as ServerSupabase;
    await sales.addStage(db, ID, { pipelineId: ID, name: 'Cerrada', kind: 'won', probability: '50' });
    expect(chain.insert).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'won', probability: 100 }));
    await sales.addStage(db, ID, { pipelineId: ID, name: 'Descartada', kind: 'lost', probability: '80' });
    expect(chain.insert).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'lost', probability: 0 }));
    await rejectsUser(sales.addStage(db, ID, { pipelineId: ID, name: 'Casi', kind: 'open', probability: '100' }));
    await rejectsUser(sales.addStage(db, ID, { pipelineId: ID, name: 'Rara', kind: 'open', probability: 'abc' }));
  });
});
