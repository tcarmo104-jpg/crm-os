import { z } from 'zod';
import type { CountryCode } from 'libphonenumber-js/min';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { buildIdentifiers, normalizeEmail, normalizeHandle, normalizePhone } from '@/lib/identity';
import * as repo from '@/repositories/customers';
import { firstIssue } from './schemas';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = (max: number) => z.preprocess(blank, z.string().trim().max(max, 'El texto es demasiado largo.').optional());
const channel = z.preprocess(blank, z.enum(['whatsapp', 'phone', 'email', 'instagram', 'facebook']).optional());
const countryCode = z.preprocess(
  blank, z.string().trim().regex(/^[A-Za-z]{2}$/, 'El país debe ser un código de 2 letras (p. ej. CO).').transform((v) => v.toUpperCase()).optional(),
);

export const newCustomerSchema = z.object({
  type: z.enum(['person', 'company'], { errorMap: () => ({ message: 'Selecciona si es persona o empresa.' }) }),
  fullName: z.string().trim().min(1, 'Escribe el nombre.').max(160, 'El nombre es demasiado largo.'),
  phone: optStr(40), email: optStr(254), instagram: optStr(120),
  city: optStr(120), country: countryCode, preferredChannel: channel,
});

export async function createCustomer(db: ServerSupabase, orgId: string, country: CountryCode, input: unknown) {
  const parsed = newCustomerSchema.safeParse(input);
  if (!parsed.success) throw new UserFacingError(firstIssue(parsed.error));
  const d = parsed.data;
  const { identifiers, problems } = buildIdentifiers({ phone: d.phone, email: d.email, instagram: d.instagram }, country);
  if (identifiers.length === 0) {
    throw new UserFacingError(problems[0] ?? 'Ingresa al menos un teléfono, correo o usuario de Instagram.');
  }
  const attrs: Record<string, unknown> = {};
  if (d.city) attrs.city = d.city;
  if (d.country) attrs.country = d.country;
  if (d.preferredChannel) attrs.preferred_channel = d.preferredChannel;
  return repo.createCustomer(db, orgId, d.type, d.fullName, identifiers, attrs);
}

export const profileSchema = z.object({
  fullName: z.string().trim().min(1, 'Escribe el nombre.').max(160, 'El nombre es demasiado largo.'),
  city: optStr(120), country: countryCode, address: optStr(300), preferredChannel: channel,
  companyId: z.preprocess(blank, z.string().uuid().optional()),
});

export async function updateProfile(db: ServerSupabase, id: string, input: unknown, customFields?: Record<string, unknown>) {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw new UserFacingError(firstIssue(parsed.error));
  const d = parsed.data;
  await repo.updateCustomer(db, id, {
    full_name: d.fullName, city: d.city ?? null, country: d.country ?? null, address: d.address ?? null,
    preferred_channel: d.preferredChannel ?? null, company_id: d.companyId ?? null,
    ...(customFields ? { custom_fields: customFields } : {}),
  });
}

export async function setDoNotContact(db: ServerSupabase, id: string, on: boolean, reason?: string) {
  await repo.updateCustomer(db, id, { do_not_contact: on, dnc_reason: on ? (reason?.trim().slice(0, 300) || null) : null });
}

export async function assignOwner(db: ServerSupabase, id: string, ownerId: string | null) {
  if (ownerId !== null && !z.string().uuid().safeParse(ownerId).success) throw new UserFacingError('Selecciona una persona válida.');
  await repo.updateCustomer(db, id, { owner_id: ownerId });
}

export const IDENTIFIER_TYPES = ['phone', 'email', 'instagram', 'facebook'] as const;
export type AddableIdentifier = (typeof IDENTIFIER_TYPES)[number];

export async function addIdentifier(db: ServerSupabase, customerId: string, country: CountryCode, type: string, raw: string) {
  if (!(IDENTIFIER_TYPES as readonly string[]).includes(type)) throw new UserFacingError('Selecciona el tipo de dato.');
  const value =
    type === 'phone' ? normalizePhone(raw, country) : type === 'email' ? normalizeEmail(raw) : normalizeHandle(raw);
  if (!value) throw new UserFacingError('Ese dato no tiene un formato válido.');
  return repo.addIdentifier(db, customerId, type, value);
}
