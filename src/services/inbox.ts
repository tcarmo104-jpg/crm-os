import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as repo from '@/repositories/inbox';
import { firstIssue } from './schemas';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  return r.data;
}

export async function sendMessage(db: ServerSupabase, input: unknown): Promise<string> {
  const d = parse(z.object({
    conversationId: z.string().uuid('Conversación no válida.'),
    body: z.string().trim().min(1, 'Escribe el mensaje.').max(4096, 'El mensaje es demasiado largo (máximo 4096 caracteres).'),
  }), input);
  return repo.queueMessage(db, d.conversationId, d.body);
}

export async function sendTemplate(db: ServerSupabase, input: unknown): Promise<string> {
  const d = parse(z.object({
    conversationId: z.string().uuid('Conversación no válida.'),
    templateId: z.string().uuid('Plantilla no válida.'),
    params: z.array(z.string().trim().min(1, 'Completa todos los datos de la plantilla.').max(500, 'Un dato de la plantilla es demasiado largo.')).max(10),
  }), input);
  return repo.queueTemplate(db, d.conversationId, d.templateId, d.params);
}

const TOKEN_HELP = 'El token de acceso de Meta es largo (más de 20 caracteres). Cópialo completo.';
export async function createChannel(db: ServerSupabase, orgId: string, input: unknown): Promise<string> {
  const d = parse(z.object({
    name: z.string().trim().min(1, 'Ponle un nombre al canal.').max(80, 'El nombre es demasiado largo.'),
    phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'El «ID del número de teléfono» son solo dígitos (lo ves en Meta → WhatsApp → Configuración de la API).'),
    displayPhone: z.preprocess(blank, z.string().trim().max(30).optional()),
    token: z.preprocess(blank, z.string().trim().min(20, TOKEN_HELP).max(2000, TOKEN_HELP).optional()),
  }), input);
  return repo.createChannel(db, orgId, d);
}
export async function saveToken(db: ServerSupabase, channelId: string, input: unknown) {
  const d = parse(z.object({ channelId: z.string().uuid(), token: z.string().trim().min(20, TOKEN_HELP).max(2000, TOKEN_HELP) }), { channelId, ...(input as object) });
  await repo.saveChannelToken(db, d.channelId, d.token);
}
export async function createTemplate(db: ServerSupabase, orgId: string, input: unknown) {
  const d = parse(z.object({
    channelId: z.string().uuid('Elige el canal.'),
    name: z.string().trim().regex(/^[a-z0-9_]{1,200}$/, 'El nombre debe ser igual al de Meta: minúsculas, números y guion bajo (ej. seguimiento_pedido).'),
    language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'El idioma debe ser como en Meta (ej. es, es_CO, en_US).'),
    body: z.string().trim().min(1, 'Escribe el texto de la plantilla.').max(1024, 'El texto es demasiado largo (máximo 1024).'),
  }), input);
  const nums = [...d.body.matchAll(/\{\{(\d{1,2})\}\}/g)].map((m) => Number(m[1]));
  const max = nums.length ? Math.max(...nums) : 0;
  if (max > 10 || new Set(nums).size !== max) throw new UserFacingError('Los datos variables deben ser {{1}}, {{2}}, {{3}}… en orden y sin saltos, igual que en Meta.');
  await repo.createTemplate(db, orgId, d);
}
