import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import * as leads from '@/repositories/leads';
import { firstIssue } from './schemas';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = (max: number) => z.preprocess(blank, z.string().trim().max(max, 'El texto es demasiado largo.').optional());

const newLeadSchema = z.object({
  name: z.string().trim().min(1, 'Escribe el nombre.').max(160, 'El nombre es demasiado largo.'),
  phone: optStr(30), email: z.preprocess(blank, z.string().trim().email('Correo no válido.').max(160).optional()),
  type: z.enum(['person', 'company']).default('person'),
  source: z.string().trim().min(1, 'Indica de dónde vino.').max(60, 'La fuente es demasiado larga.'),
  channel: optStr(60), campaign: optStr(120), productInterest: optStr(200), notes: optStr(500),
});

/** Crea un lead a mano. Traduce el formulario al mismo formato que espera la importación CSV (identificadores, no columnas sueltas). */
export async function createLead(db: ServerSupabase, orgId: string, input: unknown): Promise<leads.CreateLeadResult> {
  const r = newLeadSchema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  const d = r.data;
  if (!d.phone && !d.email) throw new UserFacingError('Escribe al menos un teléfono o un correo para poder identificar a la persona.');
  const identifiers = [
    ...(d.phone ? [{ type: 'phone', value: d.phone }] : []),
    ...(d.email ? [{ type: 'email', value: d.email }] : []),
  ];
  return leads.createLead(db, orgId, {
    name: d.name, type: d.type, identifiers, source: d.source, channel: d.channel, campaign: d.campaign,
    product_interest: d.productInterest, notes: d.notes, phone: d.phone, email: d.email,
  });
}
