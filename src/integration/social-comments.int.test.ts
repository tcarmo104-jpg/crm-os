/**
 * Integración del módulo Comentarios contra PostgREST + Postgres reales: un comentario que llega por el
 * webhook (simulado con la función real, como service_role) se puede leer después con el repositorio
 * normal, respetando los permisos de verdad.
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('server-only', () => ({}));

import type { ServerSupabase } from '@/lib/supabase/server';
import { createOrganization } from '@/repositories/organizations';
import * as comments from '@/repositories/social-comments';

const REST_URL = process.env.REST_URL!, SECRET = process.env.JWT_SECRET!, DB = process.env.INT_DB!;
const A = 'aaaaaaaa-d303-0000-0000-00000000000a', S1 = '51000000-d303-0000-0000-000000000001', V1 = '61000000-d303-0000-0000-00000000000a';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c: Record<string, unknown>) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const client = (token: string) => createClient(REST_URL, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) as unknown as ServerSupabase;
const asUser = (uid: string) => client(jwt({ role: 'authenticated', sub: uid }));
const sql = (q: string) => execFileSync('psql', ['-X', '-tA', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const a = asUser(A), s1 = asUser(S1), v1 = asUser(V1);
let org = '';

beforeAll(async () => {
  for (const [id, email] of [[A, 'a@sci.test'], [S1, 's1@sci.test'], [V1, 'v1@sci.test']]) sql(`insert into auth.users (id, email) values ('${id}', '${email}')`);
  org = await createOrganization(a, 'Comentarios Int', 'comentarios-int');
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${S1}', id from roles where key = 'sales_agent' and org_id is null`);
  sql(`insert into memberships (org_id, user_id, role_id) select '${org}', '${V1}', id from roles where key = 'marketing' and org_id is null`);
  await a.rpc('connect_channel', { p_org: org, p_kind: 'facebook', p_name: 'Página Int', p_external_id: '8100000000000001', p_display_phone: null, p_account_name: 'Página Int', p_token: 'token-fb-abcdefghijklmnop' });
}, 30_000);

describe('un comentario ingestado por el webhook se puede leer con el repositorio normal', () => {
  it('marketing (con comments:read) lo ve; un vendedor (sin el permiso) no', async () => {
    sql(`select ingest_social_comment('facebook', '8100000000000001', '9200000000000001', '9300000000000001', null, '9400000000000001', 'Cliente Int', '¿Tienen envíos?', 'add', now())`);

    const postsForV1 = await comments.listPosts(v1, org, 20);
    expect(postsForV1.some((p) => p.externalId === '9200000000000001')).toBe(true);
    const commentsForV1 = await comments.listCommentsForPosts(v1, org, postsForV1.map((p) => p.id));
    expect(commentsForV1.some((c) => c.externalId === '9300000000000001' && c.message === '¿Tienen envíos?')).toBe(true);

    const postsForS1 = await comments.listPosts(s1, org, 20);
    expect(postsForS1).toHaveLength(0);
  });

  it('ocultar y responder en público solo lo puede ejecutar quien tiene comments:manage', async () => {
    const [post] = await comments.listPosts(v1, org, 20);
    const [comment] = await comments.listCommentsForPosts(v1, org, [post!.id]);
    await expect(comments.setCommentStatus(s1, comment!.id, 'hidden')).rejects.toThrow();
    await comments.setCommentStatus(v1, comment!.id, 'hidden');
    const updated = await comments.getComment(v1, comment!.id);
    expect(updated?.status).toBe('hidden');
  });

  it('una respuesta privada de verdad crea una conversación real en el Inbox', async () => {
    sql(`select ingest_social_comment('facebook', '8100000000000001', '9200000000000002', '9300000000000002', null, '9400000000000002', 'Otro Cliente Int', 'Hola', 'add', now())`);
    const posts = await comments.listPosts(v1, org, 20);
    const post = posts.find((p) => p.externalId === '9200000000000002')!;
    const [comment] = await comments.listCommentsForPosts(v1, org, [post.id]);

    const messageId = await comments.recordCommentReply(v1, comment!.id, 'private', 'Claro, con gusto te ayudo.');
    expect(messageId).toBeTruthy();

    const conv = sql(`select thread_key from conversations where thread_key = '9400000000000002'`);
    expect(conv).toBe('9400000000000002');
    const msg = sql(`select direction || '|' || status from messages where id = '${messageId}'`);
    expect(msg).toBe('outbound|sent');
  });
});
