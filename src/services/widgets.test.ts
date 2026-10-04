import { describe, expect, it, vi } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as service from './widgets';

function fakeDb() {
  const calls: { table: string; op: string; data?: unknown }[] = [];
  const db = {
    from: (table: string) => ({
      insert: (data: unknown) => { calls.push({ table, op: 'insert', data }); return { select: () => ({ single: async () => ({ data: { id: 'w1' }, error: null }) }) }; },
      update: (data: unknown) => { calls.push({ table, op: 'update', data }); return { eq: async () => ({ data: null, error: null }) }; },
    }),
  } as unknown as ServerSupabase;
  return { db, calls };
}
const ORG = '22222222-2222-4222-8222-222222222222';
const CH = '33333333-3333-4333-8333-333333333333';
const rejects = async (p: Promise<unknown>, match?: RegExp) => { const e = await p.then(() => null, (e: unknown) => e); expect(e).toBeInstanceOf(UserFacingError); if (match) expect((e as Error).message).toMatch(match); };

describe('createWidget: valida y limpia los dominios antes de guardar', () => {
  it('arma el insert con los dominios ya limpios', async () => {
    const { db, calls } = fakeDb();
    await service.createWidget(db, ORG, { channelId: CH, name: 'Web principal', buttonText: 'Escríbenos', position: 'bottom-right', showText: true, color: '#25D366', size: 'medium', domains: 'https://www.Arkos.com.co/\narkos.com.co' });
    expect(calls[0]!.data).toMatchObject({ allowed_domains: ['arkos.com.co'], org_id: ORG, channel_id: CH });
  });
  it('rechaza sin ningún canal elegido', async () => {
    const { db } = fakeDb();
    await rejects(service.createWidget(db, ORG, { channelId: '', name: 'X', buttonText: 'X', position: 'bottom-right', showText: true, color: '#25D366', size: 'medium', domains: 'x.com' }));
  });
  it('rechaza un color que no sea un código hexadecimal válido', async () => {
    const { db } = fakeDb();
    await rejects(service.createWidget(db, ORG, { channelId: CH, name: 'X', buttonText: 'X', position: 'bottom-right', showText: true, color: 'verde', size: 'medium', domains: 'x.com' }), /color/);
  });
  it('rechaza sin ningún dominio escrito', async () => {
    const { db } = fakeDb();
    await rejects(service.createWidget(db, ORG, { channelId: CH, name: 'X', buttonText: 'X', position: 'bottom-right', showText: true, color: '#25D366', size: 'medium', domains: '   ' }));
  });
});

describe('updateWidget: misma validación al editar', () => {
  it('actualiza con los datos ya limpios', async () => {
    const { db, calls } = fakeDb();
    await service.updateWidget(db, 'w1', { channelId: CH, name: 'Renombrado', buttonText: 'Chatea', position: 'bottom-left', showText: false, color: '#128C7E', size: 'large', domains: 'otra-tienda.com' });
    expect(calls[0]!.data).toMatchObject({ name: 'Renombrado', allowed_domains: ['otra-tienda.com'] });
  });
});

describe('región del widget (la usan las reglas de distribución)', () => {
  const base = { channelId: CH, name: 'Web Medellín', buttonText: 'Escríbenos', position: 'bottom-right', showText: true, color: '#25D366', size: 'medium', domains: 'medellin.arkos.com.co' };
  it('guarda la región sin espacios sobrantes', async () => {
    const { db, calls } = fakeDb();
    await service.createWidget(db, ORG, { ...base, region: '  Medellín ' });
    expect(calls[0]!.data).toMatchObject({ region: 'Medellín' });
  });
  it('vacía o ausente se guarda como null (widget sin región)', async () => {
    const a = fakeDb(); await service.createWidget(a.db, ORG, { ...base, region: '   ' });
    expect(a.calls[0]!.data).toMatchObject({ region: null });
    const b = fakeDb(); await service.createWidget(b.db, ORG, base);
    expect(b.calls[0]!.data).toMatchObject({ region: null });
  });
  it('rechaza una región de más de 80 caracteres', async () => {
    const { db } = fakeDb();
    await rejects(service.createWidget(db, ORG, { ...base, region: 'x'.repeat(81) }), /región/);
  });
  it('al editar también envía la región (y permite quitarla)', async () => {
    const { db, calls } = fakeDb();
    await service.updateWidget(db, 'w1', { ...base, region: '' });
    expect(calls[0]!.data).toMatchObject({ region: null });
  });
});
