/**
 * Integración de la pantalla única de Analítica contra PostgREST + Postgres reales: la lista de canales del
 * filtro (respeta lo que cada rol puede ver de los leads) y el alcance compartido por todas las pestañas y el CSV
 * (filtros globales leídos de la URL, igual que en el navegador).
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { createOrganization } from '@/repositories/organizations';
import { listLeadChannels } from '@/repositories/leads';
import { loadAnalyticsScope } from '@/services/analytics-scope';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-e910-0000-0000-00000000000a', S1 = '51000000-e910-0000-0000-000000000001', S2 = '52000000-e910-0000-0000-000000000002';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1);
let org = '', teamB = '', teamM = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@ant.test'], [S1, 's1@ant.test'], [S2, 's2@ant.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Analítica Pestañas Int', 'analitica-pestanas-int');
  teamB = sql(`insert into teams (org_id, name) values ('${org}', 'Bogotá') returning id`).split('\n')[0]!;
  teamM = sql(`insert into teams (org_id, name) values ('${org}', 'Medellín') returning id`).split('\n')[0]!;
  sql(`insert into memberships (org_id, user_id, role_id, team_id) select '${org}', u.id::uuid, r.id, u.t::uuid from (values ('${S1}', '${teamB}'), ('${S2}', '${teamM}')) u(id, t) join roles r on r.key = 'sales_agent' and r.org_id is null`);
  // Leads de S1 por WhatsApp, de S2 por Messenger y uno sin canal (no debe aparecer como opción vacía).
  for (const [owner, channel, i] of [[S1, "'whatsapp'", 1], [S2, "'messenger'", 2], [S2, 'null', 3]] as const) {
    const c = sql(`insert into customers (org_id, type, full_name, owner_id) values ('${org}', 'person', 'Cliente ${i}', '${owner}') returning id`).split('\n')[0];
    sql(`insert into leads (org_id, customer_id, source, channel, resolution, owner_id) values ('${org}', '${c}', 'manual', ${channel}, 'created', '${owner}')`);
  }
}, 60_000);

describe('canales del filtro global', () => {
  it('como admin: todos los canales con leads, sin vacíos, ordenados', async () => {
    expect(await listLeadChannels(a, org)).toEqual(['messenger', 'whatsapp']);
  });
  it('como vendedor: solo los canales de lo que ya puede ver en Leads', async () => {
    expect(await listLeadChannels(s1, org)).toEqual(['whatsapp']);
  });
});

describe('alcance compartido por las pestañas y el CSV', () => {
  const orgCtx = () => ({ orgId: org, orgTimezone: 'America/Bogota' });
  it('lee los filtros de la URL igual que el navegador (personas repetidas, equipo, canal, período)', async () => {
    const sc = await loadAnalyticsScope(a, orgCtx(), new URLSearchParams(`periodo=last_7&personas=${S1}&personas=${S2}&equipos=${teamB}&canal=whatsapp`));
    expect(sc.filters).toMatchObject({ periodo: 'last_7', personas: [S1, S2], equipos: [teamB], canal: 'whatsapp' });
    expect(new Date(sc.range.to).getTime() - new Date(sc.range.from).getTime()).toBeGreaterThan(6 * 86_400_000);
  });
  it('el filtro por equipo usa los equipos reales de cada persona', async () => {
    const sc = await loadAnalyticsScope(a, orgCtx(), { equipos: teamM });
    expect([sc.matches(S1), sc.matches(S2), sc.matches(null)]).toEqual([false, true, false]);
    expect(sc.people.map((m) => m.userId)).toEqual([S2]);
    expect(sc.teamName(sc.teamOf.get(S2) ?? null)).toBe('Medellín');
  });
  it('sin filtros pasa todo, y los nombres caen al correo si no hay nombre', async () => {
    const sc = await loadAnalyticsScope(a, orgCtx(), {});
    expect(sc.filters.periodo).toBe('this_month');
    expect([sc.matches(S1), sc.matches(null)]).toEqual([true, true]);
    expect(sc.nameOf(S1)).toBe('s1@ant.test');
  });
});
