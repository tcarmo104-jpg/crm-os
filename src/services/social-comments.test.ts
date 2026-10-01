import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';

vi.mock('server-only', () => ({}));
vi.mock('@/server/meta-social', () => ({
  fetchRecentPosts: vi.fn(), fetchPostMeta: vi.fn(), replyToCommentPublic: vi.fn(), sendPrivateReplyToComment: vi.fn(), setCommentHidden: vi.fn(), deleteComment: vi.fn(),
}));
vi.mock('@/lib/secrets', () => ({ openSecret: vi.fn(() => 'decrypted-token') }));
vi.mock('@/server/supabase-admin', () => ({ createAdminClient: vi.fn(() => ({ rpc: vi.fn(async () => ({ data: 'encrypted-secret', error: null })) })) }));

import * as meta from '@/server/meta-social';
import * as service from './social-comments';

const COMMENT = { id: 'c1', channelId: 'ch1', postId: 'p1', externalId: '4400000000000001', parentExternalId: null, customerId: null, authorName: 'Juan', authorExternalId: '5500001', message: 'hola', status: 'visible' as const, occurredAt: new Date().toISOString(), repliedPubliclyAt: null, repliedPubliclyText: null, privateReplyAt: null };

function fakeDb() {
  const rpcCalls: { fn: string; args: unknown }[] = [];
  const db = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ single: async () => (table === 'channels' ? { data: { id: 'ch1', kind: 'facebook', external_id: '100000000000001' }, error: null } : { data: null, error: 'n/a' }) }) }),
    }),
    rpc: vi.fn(async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === 'channel_credentials') return { data: 'encrypted-secret', error: null };
      if (fn === 'record_comment_reply') return { data: null, error: null };
      return { data: null, error: null };
    }),
  } as unknown as ServerSupabase;
  return { db, rpcCalls };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('el token del canal nunca se lee con la sesión de la persona (misma regla que en todo el CRM)', () => {
  it('usa el cliente de administrador para leer el token, nunca el db de la persona', async () => {
    vi.spyOn(await import('@/repositories/social-comments'), 'getComment').mockResolvedValue(COMMENT);
    vi.mocked(meta.replyToCommentPublic).mockResolvedValue({ ok: true });
    const { db, rpcCalls } = fakeDb();
    await service.replyPublic(db, 'c1', 'hola');
    const { createAdminClient } = await import('@/server/supabase-admin');
    expect(createAdminClient).toHaveBeenCalled();
    expect(rpcCalls.some((c) => c.fn === 'channel_credentials')).toBe(false);
  });
});

describe('replyPublic: valida, llama a Meta, y solo si funciona guarda el resultado', () => {
  it('rechaza un mensaje vacío sin llamar a nada', async () => {
    const { db } = fakeDb();
    await expect(service.replyPublic(db, 'c1', '  ')).rejects.toBeInstanceOf(UserFacingError);
    expect(meta.replyToCommentPublic).not.toHaveBeenCalled();
  });
});

describe('replyPrivate: respeta el plazo de 7 días de Meta', () => {
  it('rechaza si el comentario tiene más de 7 días, sin llamar a Meta', async () => {
    vi.spyOn(await import('@/repositories/social-comments'), 'getComment').mockResolvedValue({ ...COMMENT, occurredAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    const { db } = fakeDb();
    await expect(service.replyPrivate(db, 'c1', 'hola')).rejects.toThrow(/7 días/);
    expect(meta.sendPrivateReplyToComment).not.toHaveBeenCalled();
  });
  it('si Meta rechaza el envío, no se guarda nada localmente', async () => {
    vi.spyOn(await import('@/repositories/social-comments'), 'getComment').mockResolvedValue(COMMENT);
    vi.mocked(meta.sendPrivateReplyToComment).mockResolvedValue({ ok: false, message: 'Meta rechazó el envío.' });
    const { db, rpcCalls } = fakeDb();
    await expect(service.replyPrivate(db, 'c1', 'El precio es $50.000')).rejects.toThrow('Meta rechazó el envío.');
    expect(rpcCalls.some((c) => c.fn === 'record_comment_reply')).toBe(false);
  });
  it('si Meta confirma, se registra como respuesta privada', async () => {
    vi.spyOn(await import('@/repositories/social-comments'), 'getComment').mockResolvedValue(COMMENT);
    vi.mocked(meta.sendPrivateReplyToComment).mockResolvedValue({ ok: true });
    const { db, rpcCalls } = fakeDb();
    await service.replyPrivate(db, 'c1', 'El precio es $50.000');
    expect(rpcCalls.find((c) => c.fn === 'record_comment_reply')?.args).toMatchObject({ p_comment_id: 'c1', p_kind: 'private', p_text: 'El precio es $50.000' });
  });
});

describe('hideComment y deleteComment: también siguen el patrón «Meta primero, base de datos después»', () => {
  it('ocultar: si Meta falla, no se guarda el cambio local', async () => {
    vi.spyOn(await import('@/repositories/social-comments'), 'getComment').mockResolvedValue(COMMENT);
    vi.mocked(meta.setCommentHidden).mockResolvedValue({ ok: false, message: 'Sin permiso en Meta.' });
    const { db, rpcCalls } = fakeDb();
    await expect(service.hideComment(db, 'c1', true)).rejects.toThrow('Sin permiso en Meta.');
    expect(rpcCalls.some((c) => c.fn === 'set_comment_status')).toBe(false);
  });
  it('eliminar: si Meta confirma, se marca eliminado localmente', async () => {
    vi.spyOn(await import('@/repositories/social-comments'), 'getComment').mockResolvedValue(COMMENT);
    vi.mocked(meta.deleteComment).mockResolvedValue({ ok: true });
    const { db, rpcCalls } = fakeDb();
    await service.deleteComment(db, 'c1');
    expect(rpcCalls.find((c) => c.fn === 'set_comment_status')?.args).toMatchObject({ p_comment_id: 'c1', p_status: 'deleted' });
  });
});
