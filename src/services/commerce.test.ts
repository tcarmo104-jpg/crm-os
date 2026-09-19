import { describe, expect, it, vi } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as commerce from './commerce';

function fakeDb() {
  const calls: { fn: string; args: unknown }[] = [];
  const chain = (table: string) => ({
    insert: (v: unknown) => ({ select: () => ({ single: async () => { calls.push({ fn: `insert:${table}`, args: v }); return { data: {}, error: null }; } }) }),
    update: (v: unknown) => ({ eq: () => ({ select: () => ({ single: async () => { calls.push({ fn: `update:${table}`, args: v }); return { data: {}, error: null }; } }) }) }),
  });
  const db = {
    rpc: vi.fn(async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: 'new-id', error: null }; }),
    from: (t: string) => chain(t),
  } as unknown as ServerSupabase;
  return { db, calls };
}
const ID = '11111111-1111-4111-8111-111111111111';
const rejectsUser = async (p: Promise<unknown>) => { await expect(p).rejects.toBeInstanceOf(UserFacingError); };

describe('catálogo', () => {
  it('interpreta precios e IVA escritos por una persona', async () => {
    const { db, calls } = fakeDb();
    await commerce.createProduct(db, ID, { kind: 'service', sku: ' CON-1 ', name: ' Consultoría ', unit: 'hora', unitPrice: '$ 150.000', taxRate: '19' });
    expect(calls[0]!.args).toMatchObject({ org_id: ID, kind: 'service', sku: 'CON-1', name: 'Consultoría', unit: 'hora', unit_price: 150000, tax_rate: 19 });
  });
  it('sin IVA es 0, sin unidad es «unidad»; rechaza precios y porcentajes inválidos', async () => {
    const { db, calls } = fakeDb();
    await commerce.createProduct(db, ID, { kind: 'product', name: 'Silla', unitPrice: '250000', taxRate: '', unit: '' });
    expect(calls[0]!.args).toMatchObject({ tax_rate: 0, unit: 'unidad' });
    await rejectsUser(commerce.createProduct(db, ID, { kind: 'product', name: 'X', unitPrice: 'gratis' }));
    await rejectsUser(commerce.createProduct(db, ID, { kind: 'product', name: 'X', unitPrice: '10', taxRate: '150' }));
    await rejectsUser(commerce.createProduct(db, ID, { kind: 'otro', name: 'X', unitPrice: '10' }));
    await rejectsUser(commerce.createProduct(db, ID, { kind: 'product', name: '  ', unitPrice: '10' }));
  });
});

describe('líneas de cotización', () => {
  it('desde el catálogo basta el producto; la cantidad por defecto es 1', async () => {
    const { db, calls } = fakeDb();
    await commerce.addItem(db, ID, { productId: ID, quantity: '', discountPct: '' });
    expect(calls[0]).toEqual({ fn: 'add_quote_item', args: {
      p_quote: ID, p_product: ID, p_description: null, p_quantity: 1, p_unit_price: null, p_discount_pct: 0, p_tax_rate: null } });
  });
  it('una línea libre exige descripción y precio', async () => {
    const { db, calls } = fakeDb();
    await rejectsUser(commerce.addItem(db, ID, { description: 'Algo', quantity: '1' }));
    await rejectsUser(commerce.addItem(db, ID, { unitPrice: '100', quantity: '1' }));
    expect(calls).toHaveLength(0);
    await commerce.addItem(db, ID, { description: 'Instalación', unitPrice: '1.500.000', quantity: '2,5', discountPct: '10', taxRate: '19' });
    expect(calls[0]!.args).toMatchObject({ p_description: 'Instalación', p_unit_price: 1500000, p_quantity: 2.5, p_discount_pct: 10, p_tax_rate: 19 });
  });
  it('rechaza cantidad 0, descuento > 100 y precio inválido', async () => {
    const { db, calls } = fakeDb();
    await rejectsUser(commerce.addItem(db, ID, { description: 'X', unitPrice: '1', quantity: '0' }));
    await rejectsUser(commerce.addItem(db, ID, { description: 'X', unitPrice: '1', quantity: '1', discountPct: '120' }));
    await rejectsUser(commerce.addItem(db, ID, { description: 'X', unitPrice: 'mucho', quantity: '1' }));
    expect(calls).toHaveLength(0);
  });
});

describe('casos', () => {
  it('resolver exige la solución', async () => {
    const { db, calls } = fakeDb();
    await rejectsUser(commerce.changeCaseStatus(db, ID, 'resolved', ' '));
    await rejectsUser(commerce.changeCaseStatus(db, ID, 'terminado'));
    await commerce.changeCaseStatus(db, ID, 'resolved', 'Se reenvió el pedido');
    expect(calls[0]).toEqual({ fn: 'set_case_status', args: { p_id: ID, p_to: 'resolved', p_note: 'Se reenvió el pedido' } });
  });
  it('abrir un caso valida cliente y título', async () => {
    const { db, calls } = fakeDb();
    await rejectsUser(commerce.openCase(db, ID, { customerId: 'x', title: 'Falla' }));
    await rejectsUser(commerce.openCase(db, ID, { customerId: ID, title: '' }));
    await commerce.openCase(db, ID, { customerId: ID, title: 'Falla del equipo', kind: 'warranty', priority: 'high', saleId: '' });
    expect(calls[0]!.args).toMatchObject({ p_kind: 'warranty', p_priority: 'high', p_sale: null });
  });
});
