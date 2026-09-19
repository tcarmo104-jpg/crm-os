import { z } from 'zod';
import type { CountryCode } from 'libphonenumber-js/min';
import { buildIdentifiers } from '@/lib/identity';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).optional().transform((v) => (v === '' ? undefined : v));

const customValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null(), z.array(z.string().max(100)).max(50)]);

/** Contrato público de POST /api/v1/leads (y de cada fila importada). */
export const leadInputSchema = z.object({
  name: optText(160),
  type: z.enum(['person', 'company']).optional(),
  email: optText(254),
  phone: optText(40),
  whatsapp: optText(40),
  instagram: optText(120),
  facebook: optText(120),
  city: optText(120),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'country debe ser un código de 2 letras (p. ej. CO)').optional(),
  source: optText(60),
  channel: optText(60),
  campaign: optText(120),
  ad: optText(120),
  form: optText(120),
  product_interest: optText(200),
  external_id: optText(200),
  consent: z.boolean().optional(),
  notes: optText(2000),
  custom_fields: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), customValue).optional(),
});
export type LeadInput = z.infer<typeof leadInputSchema>;

export type BuildResult =
  | { ok: true; payload: Record<string, unknown>; warnings: string[] }
  | { ok: false; message: string };

/**
 * Convierte la entrada (API o CSV) en el payload que entiende la base de datos:
 * identificadores YA normalizados. Requiere al menos un dato de contacto válido.
 */
export function buildIngestPayload(input: LeadInput, country: CountryCode, raw?: unknown): BuildResult {
  const { identifiers, problems } = buildIdentifiers(
    { phone: input.phone, whatsapp: input.whatsapp, email: input.email, instagram: input.instagram, facebook: input.facebook },
    country,
  );
  if (identifiers.length === 0) {
    return {
      ok: false,
      message: problems.length > 0 ? problems.join('. ') : 'Falta un dato de contacto: teléfono, correo, WhatsApp o usuario de red social.',
    };
  }

  const attrs: Record<string, unknown> = {};
  if (input.city) attrs.city = input.city;
  if (input.country) attrs.country = input.country.toUpperCase();

  const payload: Record<string, unknown> = {
    name: input.name,
    type: input.type ?? 'person',
    identifiers,
    attrs,
    source: input.source ?? 'api',
    channel: input.channel,
    campaign: input.campaign,
    ad: input.ad,
    form: input.form,
    product_interest: input.product_interest,
    external_id: input.external_id,
    email: input.email,
    phone: input.phone ?? input.whatsapp,
    consent: input.consent,
    notes: input.notes,
    custom_fields: input.custom_fields,
    raw,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return { ok: true, payload, warnings: problems };
}
