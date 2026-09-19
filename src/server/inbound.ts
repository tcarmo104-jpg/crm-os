import 'server-only';
import { parseWebhook } from '@/lib/meta';
import type { createAdminClient } from './supabase-admin';

type Admin = ReturnType<typeof createAdminClient>;
export interface ProcessSummary { messages: number; statuses: number; ignored: number; retry: boolean }

/**
 * Procesa un payload ya verificado. `retry` = algo debe reintentarse más tarde (error de base de datos, o el
 * estado de un mensaje que aún no registramos). Un canal desconocido NO se reintenta: reintentar no lo arregla.
 */
export async function processMetaPayload(admin: Admin, payload: unknown): Promise<ProcessSummary> {
  const { messages, statuses } = parseWebhook(payload);
  const sum: ProcessSummary = { messages: 0, statuses: 0, ignored: 0, retry: false };

  for (const m of messages) {
    const r = await admin.rpc('ingest_whatsapp_message', {
      p_phone_number_id: m.phoneNumberId, p_thread: m.thread, p_contact_name: m.contactName, p_external_id: m.externalId,
      p_kind: m.kind, p_body: m.body, p_occurred_at: m.occurredAt, p_meta: m.meta,
    });
    if (r.error) { sum.retry = true; continue; }
    const d = r.data as { ok: boolean; reason?: string };
    if (d.ok) sum.messages++; else sum.ignored++;
  }
  for (const s of statuses) {
    const r = await admin.rpc('apply_message_status', {
      p_phone_number_id: s.phoneNumberId, p_external_id: s.externalId, p_status: s.status, p_occurred_at: s.occurredAt,
      p_error_code: s.errorCode, p_error: s.error,
    });
    if (r.error) { sum.retry = true; continue; }
    const d = r.data as { ok: boolean; reason?: string };
    if (d.ok) sum.statuses++;
    else if (d.reason === 'unknown_message') sum.retry = true;   // el estado llegó antes de que guardáramos el id del envío
    else sum.ignored++;
  }
  return sum;
}

/** Guarda el webhook de forma durable y lo procesa. Si el guardado falla, lanza (Meta reintentará). */
export async function handleWebhook(admin: Admin, payload: unknown): Promise<ProcessSummary> {
  const rec = await admin.rpc('record_raw_event', { p_payload: payload as never });
  if (rec.error) throw new Error(`record_raw_event: ${rec.error.code ?? rec.error.message}`);
  const id = rec.data as number;
  try {
    const sum = await processMetaPayload(admin, payload);
    await admin.rpc('finish_raw_event', { p_id: id, p_ok: !sum.retry, p_error: sum.retry ? 'reintentar' : null });
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
