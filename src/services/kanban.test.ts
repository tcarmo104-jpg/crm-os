import { describe, expect, it, vi } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as kanban from './kanban';

function fakeDb() {
  const calls: { fn: string; args: unknown }[] = [];
  const db = {
    rpc: vi.fn(async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: 'id-1', error: null }; }),
    from: (t: string) => ({ update: (v: unknown) => ({ eq: () => ({ select: () => ({ single: async () => { calls.push({ fn: `update:${t}`, args: v }); return { data: {}, error: null }; } }) }) }) }),
  } as unknown as ServerSupabase;
  return { db, calls };
}
const ID = '11111111-1111-4111-8111-111111111111';
const ST = '22222222-2222-4222-8222-222222222222';
const bad = async (p: Promise<unknown>) => { await expect(p).rejects.toBeInstanceOf(UserFacingError); };

describe('servicios del tablero de oportunidades', () => {
  it('mover: valida ids y recorta el motivo; el motivo vacío no se envía', async () => {
    const { db, calls } = fakeDb();
    await kanban.moveCard(db, { id: ID, stageId: ST, reason: '  Compró con la competencia  ' });
    expect(calls[0]).toEqual({ fn: 'move_opportunity', args: { p_id: ID, p_stage: ST, p_reason: 'Compró con la competencia' } });
    await kanban.moveCard(db, { id: ID, stageId: ST, reason: '   ' });
    expect((calls[1]!.args as { p_reason: unknown }).p_reason).toBeNull();
    await bad(kanban.moveCard(db, { id: 'x', stageId: ST }));
    await bad(kanban.moveCard(db, { id: ID, stageId: 'no' }));
    await bad(kanban.moveCard(db, { id: ID, stageId: ST, reason: 'x'.repeat(501) }));
    expect(calls).toHaveLength(2);
  });
  it('prioridad/temperatura/canal: solo valores permitidos; vacío borra temperatura y canal', async () => {
    const { db, calls } = fakeDb();
    await kanban.setFields(db, { id: ID, priority: 'high', temperature: 'hot', channel: 'whatsapp' });
    expect(calls[0]).toEqual({ fn: 'update:opportunities', args: { priority: 'high', temperature: 'hot', channel: 'whatsapp' } });
    await kanban.setFields(db, { id: ID, temperature: '', channel: '' });
    expect(calls[1]!.args).toEqual({ temperature: null, channel: null });
    await kanban.setFields(db, { id: ID, priority: 'low' });
    expect(calls[2]!.args).toEqual({ priority: 'low' });
    await bad(kanban.setFields(db, { id: ID, priority: 'urgente' }));
    await bad(kanban.setFields(db, { id: ID, temperature: 'helada' }));
    await bad(kanban.setFields(db, { id: ID, channel: 'telegram' }));
  });
  it('actividad: texto obligatorio; llamadas/mensajes llevan dirección (por defecto saliente); notas no', async () => {
    const { db, calls } = fakeDb();
    await kanban.logActivity(db, { opportunityId: ID, customerId: ST, type: 'call', summary: ' Le llamé ' });
    expect(calls[0]!.args).toMatchObject({ p_type: 'call', p_summary: 'Le llamé', p_direction: 'outbound', p_opportunity: ID, p_customer: ST });
    await kanban.logActivity(db, { opportunityId: ID, customerId: ST, type: 'note', summary: 'Nota' });
    expect((calls[1]!.args as { p_direction: unknown }).p_direction).toBeNull();
    await bad(kanban.logActivity(db, { opportunityId: ID, customerId: ST, type: 'note', summary: '  ' }));
    await bad(kanban.logActivity(db, { opportunityId: ID, customerId: ST, type: 'sms', summary: 'x' }));
    await bad(kanban.logActivity(db, { opportunityId: ID, customerId: ST, type: 'note', summary: 'x'.repeat(2001) }));
  });
  it('vincular conversación: acepta un id o vacío (desvincular)', async () => {
    const { db, calls } = fakeDb();
    await kanban.linkConversation(db, { id: ID, conversationId: ST });
    await kanban.linkConversation(db, { id: ID, conversationId: '' });
    expect(calls.map((c) => (c.args as { p_conversation: unknown }).p_conversation)).toEqual([ST, null]);
    await bad(kanban.linkConversation(db, { id: ID, conversationId: 'nope' }));
  });
});
