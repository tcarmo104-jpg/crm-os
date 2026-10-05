/**
 * Integración de las métricas del widget (Fase 4) contra PostgREST + Postgres reales: un recorrido completo
 * sembrado por los caminos reales (ruta pública del widget, webhook de WhatsApp, respuesta desde el Inbox,
 * cierre, oportunidad), leído con el repositorio y resumido con el servicio — como admin y como vendedor.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { createOrganization } from '@/repositories/organizations';
import { listWidgetLeadFacts } from '@/repositories/widget-metrics';
import { loadWidgetMetrics } from '@/services/widget-metrics';
import { parseWidgetFilters, summarizeWidgetFacts, breakdownWidgetFacts } from '@/lib/analytics';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-e909-0000-0000-00000000000a', S1 = '51000000-e909-0000-0000-000000000001', S2 = '52000000-e909-0000-0000-000000000002';
const PID = '9700000001';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const service = client(jwt({ role: 'service_role' }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1), s2 = asUser(S2);
let org = '', widgetId = '';
const FROM = new Date(Date.now() - 86_400_000).toISOString(), TO = new Date(Date.now() + 86_400_000).toISOString();

async function visit(name: string, phone: string, page: string, campaign: string) {
  const r = await service.rpc('start_widget_conversation', {
    p_widget_id: widgetId, p_origin_host: 'arkos-metricas.com', p_name: name, p_phone: phone, p_company: null, p_message: 'Hola',
    p_page_url: page, p_referrer: null, p_product_url: null, p_utm_source: 'google', p_utm_medium: 'cpc', p_utm_campaign: campaign, p_utm_content: null,
  });
  expect((r.data as { ok: boolean }).ok).toBe(true);
  return sql(`select customer_id from leads where contact_phone = '${phone}' and source = 'widget_web' order by received_at desc limit 1`);
}

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@wmi.test'], [S1, 's1@wmi.test'], [S2, 's2@wmi.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Métricas Int', 'metricas-int');
  for (const u of [S1, S2]) sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${u}', id from roles where key = 'sales_agent' and org_id is null`);
  const channelId = await a.rpc('create_channel', { p_org: org, p_name: 'Ventas', p_external_id: PID, p_display_phone: '+57 300 700 0001', p_access_token: 'token-wa-abcdefghijklmnop' }).then((r) => r.data as string);
  widgetId = sql(`insert into whatsapp_widgets (org_id, channel_id, name, allowed_domains, region) values ('${org}', '${channelId}', 'Web Métricas', array['arkos-metricas.com'], 'Bogotá') returning id`).split('\n')[0]!;

  // Pedro (de S1): escribe por WhatsApp, S1 le responde desde el Inbox, cierra, y crea la oportunidad.
  const pedro = await visit('Pedro Int', '+573007000001', 'https://arkos-metricas.com/sillas?utm_source=google', 'verano');
  sql(`update customers set owner_id = '${S1}' where id = '${pedro}'`);
  await service.rpc('ingest_whatsapp_message', { p_phone_number_id: PID, p_thread: '573007000001', p_contact_name: 'Pedro', p_external_id: 'wamid.INT1', p_kind: 'text', p_body: 'Hola, vengo de la web', p_occurred_at: new Date().toISOString() });
  const conv = sql(`select id from conversations where customer_id = '${pedro}'`);
  expect((await s1.rpc('queue_message', { p_conversation: conv, p_body: 'Hola Pedro' })).error).toBeNull();
  expect((await s1.rpc('set_conversation_status', { p_id: conv, p_status: 'closed' })).error).toBeNull();
  expect((await s1.rpc('create_opportunity', { p_customer: pedro, p_title: 'Sillas' })).error).toBeNull();

  // Lucía (de S2): llenó el formulario y nunca escribió.
  const lucia = await visit('Lucía Int', '+573007000002', 'https://arkos-metricas.com/mesas', 'otoño');
  sql(`update customers set owner_id = '${S2}' where id = '${lucia}'`);
}, 60_000);

describe('el repositorio trae los hechos reales, con los permisos de la base de datos', () => {
  it('como admin: los dos leads, con su recorrido', async () => {
    const { items, truncated } = await listWidgetLeadFacts(a, { orgId: org, from: FROM, to: TO });
    expect(truncated).toBe(false);
    expect(items).toHaveLength(2);
    const pedro = items.find((f) => f.utmCampaign === 'verano')!;
    expect(pedro).toMatchObject({ isNew: true, widgetName: 'Web Métricas', region: 'Bogotá', ownerId: S1 });
    expect(pedro.firstInboundAt && pedro.firstResponseAt && pedro.closedAt && pedro.opportunityId).toBeTruthy();
    const lucia = items.find((f) => f.utmCampaign === 'otoño')!;
    expect(lucia).toMatchObject({ firstInboundAt: null, opportunityId: null, ownerId: S2 });
  });
  it('como vendedor: solo lo suyo (aunque la función use privilegios propios, aplica el mismo filtro que Leads)', async () => {
    const mine = await listWidgetLeadFacts(s2, { orgId: org, from: FROM, to: TO });
    expect(mine.items.map((f) => f.ownerId)).toEqual([S2]);
  });
  it('el tope de filas se respeta y se informa', async () => {
    const r = await listWidgetLeadFacts(a, { orgId: org, from: FROM, to: TO, limit: 1 });
    expect(r.items).toHaveLength(1); expect(r.truncated).toBe(true);
  });
  it('sin sesión (anon) no se puede consultar', async () => {
    const anon = client(jwt({ role: 'anon' }));
    await expect(listWidgetLeadFacts(anon, { orgId: org, from: FROM, to: TO })).rejects.toThrow();
  });
});

describe('el servicio arma lo que muestra la página (y descarga el CSV)', () => {
  it('resumen y desglose por página, con filtros', async () => {
    const data = await loadWidgetMetrics(a, { orgId: org, orgTimezone: 'America/Bogota' }, parseWidgetFilters({ periodo: 'today' }));
    const s = summarizeWidgetFacts(data.facts);
    expect(s).toMatchObject({ started: 2, reachedWhatsapp: 1, newContacts: 2, opportunities: 1, answered: 1, resolved: 1, oppRate: 50 });
    expect(breakdownWidgetFacts(data.facts, 'pagina', data.labelOf('pagina')).map((r) => r.label).sort()).toEqual(['arkos-metricas.com/mesas', 'arkos-metricas.com/sillas']);
    expect(breakdownWidgetFacts(data.facts, 'asesor', data.labelOf('asesor')).map((r) => r.label).sort()).toEqual(['s1@wmi.test', 's2@wmi.test']);

    const onlyVerano = await loadWidgetMetrics(a, { orgId: org, orgTimezone: 'America/Bogota' }, parseWidgetFilters({ periodo: 'today', campana: 'VERANO' }));
    expect(onlyVerano.facts).toHaveLength(1);
    expect(onlyVerano.all).toHaveLength(2);   // las opciones de los filtros siguen viendo todo el período
  });
});
