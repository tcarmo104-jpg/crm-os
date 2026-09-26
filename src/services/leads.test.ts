import { describe, expect, it, vi } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as leads from './leads';

function fakeDb() {
  const calls: { fn: string; args: unknown }[] = [];
  const db = { rpc: vi.fn(async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: { lead_id: 'l1', customer_id: 'c1', outcome: 'created', deduplicated: false }, error: null }; }) } as unknown as ServerSupabase;
  return { db, calls };
}
const ORG = '22222222-2222-4222-8222-222222222222';
const rejectsUser = async (p: Promise<unknown>, match?: RegExp) => { const e = await p.then(() => null, (e: unknown) => e); expect(e).toBeInstanceOf(UserFacingError); if (match) expect((e as Error).message).toMatch(match); };

describe('createLead: arma identificadores como los espera app.ingest_lead_core (mismo camino que la importación CSV)', () => {
  it('con teléfono y correo: dos identificadores, en el mismo formato que un renglón de CSV', async () => {
    const { db, calls } = fakeDb();
    const r = await leads.createLead(db, ORG, { name: '  Camila Ruiz ', phone: '+573001110000', email: 'camila@ejemplo.com', source: 'feria', productInterest: 'Wallpanel' });
    expect(calls[0]).toEqual({ fn: 'create_lead', args: { p_org: ORG, p_row: {
      name: 'Camila Ruiz', type: 'person', identifiers: [{ type: 'phone', value: '+573001110000' }, { type: 'email', value: 'camila@ejemplo.com' }],
      source: 'feria', channel: undefined, campaign: undefined, product_interest: 'Wallpanel', notes: undefined, phone: '+573001110000', email: 'camila@ejemplo.com',
    } } });
    expect(r).toEqual({ leadId: 'l1', customerId: 'c1', outcome: 'created', deduplicated: false });
  });
  it('con solo uno de los dos (teléfono O correo) basta', async () => {
    const { db, calls } = fakeDb();
    await leads.createLead(db, ORG, { name: 'Solo teléfono', phone: '+573001110001', source: 'web' });
    expect((calls[0]!.args as { p_row: { identifiers: unknown[] } }).p_row.identifiers).toEqual([{ type: 'phone', value: '+573001110001' }]);
  });
  it('sin ninguno de los dos, se rechaza ANTES de llamar a la base de datos', async () => {
    const { db, calls } = fakeDb();
    await rejectsUser(leads.createLead(db, ORG, { name: 'Sin contacto', source: 'web' }), /teléfono o un correo/);
    expect(calls).toHaveLength(0);
  });
  it('rechaza sin nombre, sin fuente, o con correo mal escrito, sin tocar la base de datos', async () => {
    const { db, calls } = fakeDb();
    await rejectsUser(leads.createLead(db, ORG, { name: '  ', phone: '+573001110000', source: 'web' }));
    await rejectsUser(leads.createLead(db, ORG, { name: 'X', phone: '+573001110000', source: '' }));
    await rejectsUser(leads.createLead(db, ORG, { name: 'X', email: 'no-es-correo', source: 'web' }));
    expect(calls).toHaveLength(0);
  });
  it('empresa: se manda type=company', async () => {
    const { db, calls } = fakeDb();
    await leads.createLead(db, ORG, { name: 'Constructora XYZ', type: 'company', phone: '+573001110002', source: 'referido' });
    expect((calls[0]!.args as { p_row: { type: string } }).p_row.type).toBe('company');
  });
});
