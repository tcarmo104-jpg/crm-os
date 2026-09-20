import 'server-only';
import { parseWebhook } from '@/lib/meta';
import { isSocialPayload, parseSocialWebhook } from '@/lib/social';
import { openSecret } from '@/lib/secrets';
import { fetchContactName } from './meta-social';
import { registerAttachments } from './media';
import type { createAdminClient } from './supabase-admin';

type Admin = ReturnType<typeof createAdminClient>;
export interface ProcessSummary { messages: number; statuses: number; ignored: number; retry: boolean }

/**
 * Procesa un payload ya verificado. `retry` = algo debe reintentarse más tarde (error de base de datos, o el
 * estado de un mensaje que aún no registramos). Un canal desconocido NO se reintenta: reintentar no lo arregla.
 */
export async function processMetaPayload(admin: Admin, payload: unknown, deps: { fetchImpl?: typeof fetch } = {}): Promise<ProcessSummary> {
  if (isSocialPayload(payload)) return processSocialPayload(admin, payload, deps);
  const { messages, statuses } = parseWebhook(payload);
  const sum: ProcessSummary = { messages: 0, statuses: 0, ignored: 0, retry: false };
  const alive = new Set<string>();   // números cuyo webhook acaba de demostrar que funciona

  for (const m of messages) {
    const r = await admin.rpc('ingest_whatsapp_message', {
      p_phone_number_id: m.phoneNumberId, p_thread: m.thread, p_contact_name: m.contactName, p_external_id: m.externalId,
      p_kind: m.kind, p_body: m.body, p_occurred_at: m.occurredAt, p_meta: m.meta,
    });
    if (r.error) { sum.retry = true; continue; }
    const d = r.data as { ok: boolean; reason?: string };
    if (d.ok) {
      sum.messages++; alive.add(m.phoneNumberId);
      // También si el mensaje ya existía (webhook reintentado): así nunca se pierde un adjunto por un fallo entre pasos.
      if (m.attachments?.length && !(await registerAttachments(admin, 'whatsapp', m.phoneNumberId, m.externalId, m.attachments))) sum.retry = true;
    } else {
      sum.ignored++;
      // Diagnóstico: el ID del número que manda Meta no coincide con ningún canal conectado.
      console.warn(JSON.stringify({ msg: 'meta_unknown_channel', phone_number_id: m.phoneNumberId, reason: d.reason }));
    }
  }
  for (const s of statuses) {
    const r = await admin.rpc('apply_message_status', {
      p_phone_number_id: s.phoneNumberId, p_external_id: s.externalId, p_status: s.status, p_occurred_at: s.occurredAt,
      p_error_code: s.errorCode, p_error: s.error,
    });
    if (r.error) { sum.retry = true; continue; }
    const d = r.data as { ok: boolean; reason?: string };
    if (d.ok) { sum.statuses++; alive.add(s.phoneNumberId); }
    else if (d.reason === 'unknown_message') sum.retry = true;   // el estado llegó antes de que guardáramos el id del envío
    else sum.ignored++;
  }
  // Mejor esfuerzo: anotar la actividad nunca debe hacer fallar (ni reintentar) un webhook ya procesado.
  for (const id of alive) await admin.rpc('touch_channel', { p_phone_number_id: id, p_kind: 'webhook' }).then(() => undefined, () => undefined);
  return sum;
}

/** Guarda el webhook de forma durable y lo procesa. Si el guardado falla, lanza (Meta reintentará). */
export async function handleWebhook(admin: Admin, payload: unknown): Promise<ProcessSummary> {
  const rec = await admin.rpc('record_raw_event', { p_payload: payload as never });
  if (rec.error) throw new Error(`record_raw_event: ${rec.error.code ?? rec.error.message}`);
  const id = rec.data as number;
  try {
    const sum = await processMetaPayload(admin, payload);
    await admin.rpc('finish_raw_event', { p_id: id, p_ok: !sum.retry, p_error: sum.retry ? 'reintentar' : sum.ignored > 0 ? 'ignorado: el ID del número no coincide con ningún canal' : null });
    return sum;
  } catch (e) {
    await admin.rpc('finish_raw_event', { p_id: id, p_ok: false, p_error: e instanceof Error ? e.message.slice(0, 200) : 'error' });
    return { messages: 0, statuses: 0, ignored: 0, retry: true };   // guardado: el barrido lo reintenta
  }
}

/** Barrido: reintenta webhooks pendientes y purga los viejos ya procesados. */
export async function sweepWebhooks(admin: Admin): Promise<{ retried: number; purged: number }> {
  const c = await admin.rpc('claim_raw_events', { p_limit: 20, p_min_age_seconds: 30 });
  if (c.error) throw new Error(`claim_raw_events: ${c.error.code ?? c.error.message}`);
  let retried = 0;
  for (const ev of (c.data ?? []) as { id: number; payload: unknown }[]) {
    try {
      const sum = await processMetaPayload(admin, ev.payload);
      await admin.rpc('finish_raw_event', { p_id: ev.id, p_ok: !sum.retry, p_error: sum.retry ? 'reintentar' : null });
    } catch (e) {
      await admin.rpc('finish_raw_event', { p_id: ev.id, p_ok: false, p_error: e instanceof Error ? e.message.slice(0, 200) : 'error' });
    }
    retried++;
  }
  const p = await admin.rpc('purge_raw_events', { p_days: 30 });
  return { retried, purged: typeof p.data === 'number' ? p.data : 0 };
}

/**
 * Mensajes de Facebook Messenger e Instagram Direct. Misma regla que WhatsApp: canal → contacto → conversación;
 * la persona que vuelve a escribir continúa SU conversación (no se crea otro cliente ni otro lead).
 */
async function processSocialPayload(admin: Admin, payload: unknown, deps: { fetchImpl?: typeof fetch }): Promise<ProcessSummary> {
  const { messages, statuses } = parseSocialWebhook(payload);
  const sum: ProcessSummary = { messages: 0, statuses: 0, ignored: 0, retry: false };
  const alive = new Map<string, { kind: string; accountId: string }>();

  for (const m of messages) {
    const r = await admin.rpc('ingest_channel_message', {
      p_kind: m.kind, p_account_id: m.accountId, p_thread: m.thread, p_contact_name: null, p_external_id: m.externalId,
      p_msg_kind: m.msgKind, p_body: m.body, p_occurred_at: m.occurredAt, p_meta: m.meta,
    });
    if (r.error) { sum.retry = true; continue; }
    const d = r.data as { ok: boolean; reason?: string; new_conversation?: boolean; conversation_id?: string };
    if (!d.ok) {
      sum.ignored++;
      console.warn(JSON.stringify({ msg: 'meta_unknown_channel', kind: m.kind, account_id: m.accountId, reason: d.reason }));
      continue;
    }
    sum.messages++;
    alive.set(`${m.kind}:${m.accountId}`, { kind: m.kind, accountId: m.accountId });
    if (m.attachments?.length && !(await registerAttachments(admin, m.kind, m.accountId, m.externalId, m.attachments))) sum.retry = true;
    if (d.new_conversation && d.conversation_id) await fillContactName(admin, m.kind, m.accountId, m.thread, d.conversation_id, deps);
  }
  for (const s of statuses) {
    const r = await admin.rpc('apply_channel_status', { p_kind: s.kind, p_account_id: s.accountId, p_external_id: s.externalId, p_status: s.status, p_occurred_at: s.occurredAt, p_error_code: null, p_error: null });
    if (r.error) { sum.retry = true; continue; }
    const d = r.data as { ok: boolean; reason?: string };
    if (d.ok) { sum.statuses++; alive.set(`${s.kind}:${s.accountId}`, { kind: s.kind, accountId: s.accountId }); }
    else if (d.reason === 'unknown_message') sum.ignored++;   // p. ej. un mensaje enviado desde otra app: no es nuestro
    else sum.ignored++;
  }
  for (const a of alive.values()) await admin.rpc('touch_channel', { p_kind: a.kind, p_external_id: a.accountId, p_activity: 'webhook' }).then(() => undefined, () => undefined);
  return sum;
}

/** El webhook de Meta no trae el nombre: se pide una vez al abrir la conversación. Mejor esfuerzo, nunca hace fallar el webhook. */
async function fillContactName(admin: Admin, kind: string, accountId: string, thread: string, conversationId: string, deps: { fetchImpl?: typeof fetch }) {
  try {
    const ch = await admin.from('channels').select('id').eq('kind', kind).eq('external_id', accountId).maybeSingle();
    const id = (ch.data as { id: string } | null)?.id;
    if (!id) return;
    const cred = await admin.rpc('channel_credentials', { p_channel: id });
    if (typeof cred.data !== 'string' || !cred.data) return;
    const name = await fetchContactName(kind as 'facebook' | 'instagram', thread, openSecret(cred.data), deps);
    if (name) await admin.rpc('set_contact_profile', { p_conversation: conversationId, p_name: name });
  } catch { /* se queda el nombre provisional */ }
}

// ---------------------------------------------------------------------------------------------- aislamiento por organización
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Un aviso firmado con la aplicación de META de una organización SOLO puede afectar a los canales de esa organización. Antes de guardar
 * nada se descarta todo lo que hable de canales ajenos (o desconocidos): así una empresa no puede falsificar mensajes para el canal de otra,
 * y los reintentos futuros trabajan con el aviso ya depurado.
 */
export async function restrictPayloadToOrg(admin: Admin, payload: unknown, orgId: string): Promise<unknown> {
  if (!isRec(payload)) return payload;
  const kind = payload.object === 'whatsapp_business_account' ? 'whatsapp' : payload.object === 'page' ? 'facebook' : payload.object === 'instagram' ? 'instagram' : null;
  if (!kind) return { ...payload, entry: [] };
  const r = await admin.from('channels').select('external_id').eq('org_id', orgId).eq('kind', kind);
  const owned = new Set(((r.data ?? []) as { external_id: string }[]).map((c) => c.external_id));
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const keep: unknown[] = [];
  for (const e of entries) {
    if (!isRec(e)) continue;
    if (kind === 'whatsapp') {
      const changes = (Array.isArray(e.changes) ? e.changes : []).filter((c) => isRec(c) && isRec(c.value) && isRec(c.value.metadata) && owned.has(String(c.value.metadata.phone_number_id ?? '')));
      if (changes.length > 0) keep.push({ ...e, changes });
    } else if (owned.has(String(e.id ?? ''))) keep.push(e);
  }
  if (keep.length !== entries.length) console.warn(JSON.stringify({ msg: 'meta_payload_filtered', kind, dropped: entries.length - keep.length }));
  return { ...payload, entry: keep };
}
