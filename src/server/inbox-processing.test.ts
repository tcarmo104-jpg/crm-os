import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import { deliverMessage, sweepOutbound } from './outbound';
import { handleWebhook, processMetaPayload, sweepWebhooks } from './inbound';
import type { SendInput, SendResult } from './whatsapp';

type Reply = { data?: unknown; error?: { code?: string; message: string } | null };
/** Base de datos simulada: responde por nombre de RPC y registra cada llamada. */
function fakeAdmin(replies: Record<string, Reply | ((args: Record<string, unknown>) => Reply)>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      const r = replies[fn];
      const v = typeof r === 'function' ? r(args) : r;
      return { data: v?.data ?? null, error: v?.error ?? null };
    }),
  };
  return { admin: admin as never, calls };
}
const claimed = (over: Record<string, unknown> = {}) => ({
  message_id: 'm1', kind: 'text', body: 'Hola', to: '573001112233', phone_number_id: '109876543210', channel_id: 'ch1',
  template_name: null, template_language: null, template_params: null, ...over,
});

describe('entrega de mensajes salientes', () => {
  it('éxito: reclama, obtiene el token, envía y registra el id de Meta', async () => {
    const send = vi.fn(async (_i: SendInput): Promise<SendResult> => ({ ok: true, externalId: 'wamid.X' }));
    const { admin, calls } = fakeAdmin({ claim_outbound: { data: claimed() }, channel_credentials: { data: 'EAAB-token-abcdefghijklmnopqrstuv' }, finish_outbound: {} });
    expect(await deliverMessage(admin, 'm1', send)).toBe('sent');
    expect(send.mock.calls[0]![0]).toMatchObject({ phoneNumberId: '109876543210', to: '573001112233', kind: 'text', body: 'Hola', token: 'EAAB-token-abcdefghijklmnopqrstuv' });
    expect(calls.find((c) => c.fn === 'finish_outbound')!.args).toEqual({ p_message: 'm1', p_ok: true, p_external_id: 'wamid.X' });
  });
  it('plantilla: pasa nombre, idioma y parámetros', async () => {
    const send = vi.fn(async (_i: SendInput): Promise<SendResult> => ({ ok: true, externalId: 'w' }));
    const { admin } = fakeAdmin({ claim_outbound: { data: claimed({ kind: 'template', template_name: 'seguimiento', template_language: 'es', template_params: ['Carlos', 'A-1'] }) }, channel_credentials: { data: 'EAAB-token-abcdefghijklmnopqrstuv' }, finish_outbound: {} });
    await deliverMessage(admin, 'm1', send);
    expect(send.mock.calls[0]![0]).toMatchObject({ kind: 'template', templateName: 'seguimiento', templateLanguage: 'es', templateParams: ['Carlos', 'A-1'] });
  });
  it('si otro proceso ya lo reclamó: no envía NADA', async () => {
    const send = vi.fn();
    const { admin } = fakeAdmin({ claim_outbound: { data: null } });
    expect(await deliverMessage(admin, 'm1', send as never)).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });
  it('sin token configurado: falla con un mensaje claro y no llama a Meta', async () => {
    const send = vi.fn();
    const { admin, calls } = fakeAdmin({ claim_outbound: { data: claimed() }, channel_credentials: { data: null }, finish_outbound: {} });
    expect(await deliverMessage(admin, 'm1', send as never)).toBe('failed');
    expect(send).not.toHaveBeenCalled();
    expect(calls.find((c) => c.fn === 'finish_outbound')!.args).toMatchObject({ p_ok: false, p_error_code: 'no_token' });
  });
  it('rechazo definitivo de Meta: queda «falló» con el motivo', async () => {
    const { admin, calls } = fakeAdmin({ claim_outbound: { data: claimed() }, channel_credentials: { data: 'EAAB-token-abcdefghijklmnopqrstuv' }, finish_outbound: {} });
    const r = await deliverMessage(admin, 'm1', async () => ({ ok: false, definitive: true, code: '131047', message: 'fuera de ventana' }));
    expect(r).toBe('failed');
    expect(calls.find((c) => c.fn === 'finish_outbound')!.args).toEqual({ p_message: 'm1', p_ok: false, p_error_code: '131047', p_error: 'fuera de ventana' });
  });
  it('resultado DESCONOCIDO: no se marca ni se reenvía (el barrido decide sin duplicar)', async () => {
    const { admin, calls } = fakeAdmin({ claim_outbound: { data: claimed() }, channel_credentials: { data: 'EAAB-token-abcdefghijklmnopqrstuv' } });
    expect(await deliverMessage(admin, 'm1', async () => ({ ok: false, definitive: false, message: 'sin respuesta' }))).toBe('unknown');
    expect(calls.some((c) => c.fn === 'finish_outbound')).toBe(false);
  });
  it('un error de base de datos al reclamar se propaga (no se envía a ciegas)', async () => {
    const send = vi.fn();
    const { admin } = fakeAdmin({ claim_outbound: { error: { code: '57P01', message: 'down' } } });
    await expect(deliverMessage(admin, 'm1', send as never)).rejects.toThrow(/claim_outbound/);
    expect(send).not.toHaveBeenCalled();
  });
  it('el barrido envía los encolados y cuenta los vencidos; un fallo individual no detiene a los demás', async () => {
    let n = 0;
    const { admin } = fakeAdmin({
      sweep_outbound: { data: { retry_ids: ['a', 'b'], expired: 2 } },
      claim_outbound: () => (++n === 1 ? { error: { message: 'boom' } } : { data: null }),
    });
    expect(await sweepOutbound(admin)).toEqual({ retried: 0, expired: 2 });
    expect(n).toBe(2);
  });
});

const payload = (statuses?: unknown[], messages?: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '109876543210' }, contacts: [{ profile: { name: 'Laura' }, wa_id: '573101112233' }, ], messages, statuses } }] }],
});
const inMsg = { from: '573101112233', id: 'wamid.1', timestamp: '1758300000', type: 'text', text: { body: 'Hola' } };

describe('procesamiento de webhooks', () => {
  it('cada mensaje se entrega a la base de datos con sus datos normalizados', async () => {
    const { admin, calls } = fakeAdmin({ ingest_whatsapp_message: { data: { ok: true } } });
    const s = await processMetaPayload(admin, payload(undefined, [inMsg]));
    expect(s).toMatchObject({ messages: 1, retry: false });
    expect(calls[0]!.args).toMatchObject({ p_phone_number_id: '109876543210', p_thread: '573101112233', p_contact_name: 'Laura', p_external_id: 'wamid.1', p_kind: 'text', p_body: 'Hola' });
  });
  it('un canal desconocido se ignora SIN reintentar (reintentar no lo arregla)', async () => {
    const { admin } = fakeAdmin({ ingest_whatsapp_message: { data: { ok: false, reason: 'unknown_channel' } } });
    expect(await processMetaPayload(admin, payload(undefined, [inMsg]))).toMatchObject({ messages: 0, ignored: 1, retry: false });
  });
  it('un error de base de datos pide reintento pero sigue con el resto del lote', async () => {
    let n = 0;
    const { admin } = fakeAdmin({ ingest_whatsapp_message: () => (++n === 1 ? { error: { message: 'x' } } : { data: { ok: true } }) });
    const s = await processMetaPayload(admin, payload(undefined, [inMsg, { ...inMsg, id: 'wamid.2' }]));
    expect(s).toMatchObject({ messages: 1, retry: true });
  });
  it('el estado de un mensaje que aún no conocemos pide reintento (carrera con nuestro propio envío)', async () => {
    const { admin } = fakeAdmin({ apply_message_status: { data: { ok: false, reason: 'unknown_message' } } });
    expect(await processMetaPayload(admin, payload([{ id: 'o1', status: 'delivered', timestamp: '1758300000' }]))).toMatchObject({ retry: true });
    const ok = fakeAdmin({ apply_message_status: { data: { ok: true, applied: true } } });
    expect(await processMetaPayload(ok.admin, payload([{ id: 'o1', status: 'read', timestamp: '1' }]))).toMatchObject({ statuses: 1, retry: false });
  });
  it('se guarda ANTES de procesar; si no se puede guardar, lanza (Meta reintentará)', async () => {
    const order: string[] = [];
    const { admin } = fakeAdmin({
      record_raw_event: () => { order.push('record'); return { data: 7 }; },
      ingest_whatsapp_message: () => { order.push('ingest'); return { data: { ok: true } }; },
      finish_raw_event: () => { order.push('finish'); return {}; },
    });
    await handleWebhook(admin, payload(undefined, [inMsg]));
    expect(order).toEqual(['record', 'ingest', 'finish']);
    const bad = fakeAdmin({ record_raw_event: { error: { code: '57P01', message: 'down' } } });
    await expect(handleWebhook(bad.admin, payload(undefined, [inMsg]))).rejects.toThrow(/record_raw_event/);
  });
  it('si el procesamiento revienta, el evento queda pendiente para el barrido (no se pierde) y NO lanza', async () => {
    const { admin, calls } = fakeAdmin({ record_raw_event: { data: 9 }, ingest_whatsapp_message: () => { throw new Error('inesperado'); }, finish_raw_event: {} });
    const s = await handleWebhook(admin, payload(undefined, [inMsg]));
    expect(s.retry).toBe(true);
    expect(calls.find((c) => c.fn === 'finish_raw_event')!.args).toMatchObject({ p_id: 9, p_ok: false });
  });
  it('el barrido reintenta los pendientes y purga los viejos', async () => {
    const { admin, calls } = fakeAdmin({
      claim_raw_events: { data: [{ id: 1, payload: payload(undefined, [inMsg]) }, { id: 2, payload: payload(undefined, [{ ...inMsg, id: 'wamid.9' }]) }] },
      ingest_whatsapp_message: { data: { ok: true } }, finish_raw_event: {}, purge_raw_events: { data: 3 },
    });
    expect(await sweepWebhooks(admin)).toEqual({ retried: 2, purged: 3 });
    expect(calls.filter((c) => c.fn === 'finish_raw_event').every((c) => c.args.p_ok === true)).toBe(true);
  });
});
