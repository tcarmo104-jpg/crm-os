import { describe, expect, it, vi } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as inbox from './inbox';

function fakeDb() {
  const calls: { fn: string; args: unknown }[] = [];
  const db = {
    rpc: vi.fn(async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: 'id-1', error: null }; }),
    from: (t: string) => ({ insert: (v: unknown) => ({ select: () => ({ single: async () => { calls.push({ fn: `insert:${t}`, args: v }); return { data: {}, error: null }; } }) }) }),
  } as unknown as ServerSupabase;
  return { db, calls };
}
const ID = '11111111-1111-4111-8111-111111111111';
const bad = async (p: Promise<unknown>) => { await expect(p).rejects.toBeInstanceOf(UserFacingError); };

describe('servicios de la bandeja', () => {
  it('enviar: recorta el texto y exige contenido y largo válidos', async () => {
    const { db, calls } = fakeDb();
    expect(await inbox.sendMessage(db, { conversationId: ID, body: '  Hola  ' })).toBe('id-1');
    expect(calls[0]).toEqual({ fn: 'queue_message', args: { p_conversation: ID, p_body: 'Hola' } });
    await bad(inbox.sendMessage(db, { conversationId: ID, body: '   ' }));
    await bad(inbox.sendMessage(db, { conversationId: ID, body: 'x'.repeat(4097) }));
    await bad(inbox.sendMessage(db, { conversationId: 'x', body: 'hola' }));
    expect(calls).toHaveLength(1);
  });
  it('plantilla: exige todos los datos', async () => {
    const { db, calls } = fakeDb();
    await inbox.sendTemplate(db, { conversationId: ID, templateId: ID, params: [' Carlos ', 'A-1'] });
    expect(calls[0]!.args).toEqual({ p_conversation: ID, p_template: ID, p_params: ['Carlos', 'A-1'] });
    await bad(inbox.sendTemplate(db, { conversationId: ID, templateId: ID, params: ['Carlos', ''] }));
  });
  it('canal: el id de teléfono son dígitos y el token es largo; nombres y mensajes de ayuda en español', async () => {
    const { db, calls } = fakeDb();
    await inbox.createChannel(db, ID, { name: ' Ventas ', phoneNumberId: ' 109876543210 ', displayPhone: '', token: 'EAAB-token-abcdefghijklmnopqrstuvwxyz' });
    expect(calls[0]!.args).toMatchObject({ p_name: 'Ventas', p_external_id: '109876543210', p_display_phone: null });
    await bad(inbox.createChannel(db, ID, { name: 'X', phoneNumberId: '+57 300 111' }));
    await bad(inbox.createChannel(db, ID, { name: 'X', phoneNumberId: '109876543210', token: 'corto' }));
    await bad(inbox.createChannel(db, ID, { name: '  ', phoneNumberId: '109876543210' }));
    await expect(inbox.createChannel(db, ID, { name: 'X', phoneNumberId: 'abc' })).rejects.toThrow(/ID del número de teléfono/);
  });
  it('plantilla de Meta: nombre, idioma y marcadores en orden', async () => {
    const { db, calls } = fakeDb();
    await inbox.createTemplate(db, ID, { channelId: ID, name: 'seguimiento_pedido', language: 'es_CO', body: 'Hola {{1}}, tu pedido {{2}}' });
    expect(calls[0]!.fn).toBe('insert:message_templates');
    await bad(inbox.createTemplate(db, ID, { channelId: ID, name: 'Mal Nombre', language: 'es', body: 'x' }));
    await bad(inbox.createTemplate(db, ID, { channelId: ID, name: 'ok', language: 'ES', body: 'x' }));
    await expect(inbox.createTemplate(db, ID, { channelId: ID, name: 'ok', language: 'es', body: '{{1}} y {{3}}' })).rejects.toThrow(/en orden y sin saltos/);
  });
});
