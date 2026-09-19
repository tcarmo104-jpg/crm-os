import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { parseAmount, parsePercent, parseQuantity } from '@/lib/money';
import * as products from '@/repositories/products';
import * as quotes from '@/repositories/quotes';
import * as sales from '@/repositories/sales';
import { firstIssue } from './schemas';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = (max: number) => z.preprocess(blank, z.string().trim().max(max, 'El texto es demasiado largo.').optional());
const optUuid = z.preprocess(blank, z.string().uuid('Selección no válida.').optional());
const dateOnly = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida.').optional());

const money = (msg: string) => z.preprocess((v) => (typeof v === 'string' ? parseAmount(v) : v), z.number({ invalid_type_error: msg, required_error: msg }).min(0, msg).max(1_000_000_000, 'El valor es demasiado grande.'));
const optMoney = z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? parseAmount(v) : blank(v)), z.number({ invalid_type_error: 'Escribe un valor válido (por ejemplo 150.000).' }).min(0).max(1_000_000_000).optional());
const percent = (msg: string, dflt?: number) => z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? dflt : parsePercent(v)) : v ?? dflt),
  z.number({ invalid_type_error: msg, required_error: msg }).min(0, msg).max(100, msg),
);
const optPercent = z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? parsePercent(v) : blank(v)), z.number({ invalid_type_error: 'El porcentaje debe estar entre 0 y 100.' }).min(0).max(100).optional());

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  return r.data;
}

// ---------------------------------------------------------------- catálogo
const productSchema = z.object({
  kind: z.enum(['product', 'service'], { errorMap: () => ({ message: 'Selecciona si es producto o servicio.' }) }),
  sku: optStr(60), name: z.string().trim().min(1, 'Escribe el nombre.').max(160, 'El nombre es demasiado largo.'),
  description: optStr(1000), unit: z.preprocess(blank, z.string().trim().min(1).max(30).default('unidad')),
  unitPrice: money('Escribe un precio válido (por ejemplo 150.000).'), taxRate: percent('El IVA debe estar entre 0 y 100.', 0),
});
export async function createProduct(db: ServerSupabase, orgId: string, input: unknown) {
  return products.createProduct(db, orgId, parse(productSchema, input));
}
export async function updateProduct(db: ServerSupabase, id: string, input: unknown) {
  const d = parse(productSchema.omit({ kind: true }), input);
  await products.updateProduct(db, id, {
    sku: d.sku ?? null, name: d.name, description: d.description ?? null, unit: d.unit, unit_price: d.unitPrice, tax_rate: d.taxRate,
  });
}

// ---------------------------------------------------------------- cotizaciones
export async function createQuote(db: ServerSupabase, opportunityId: string, input: unknown) {
  const d = parse(z.object({ validUntil: dateOnly, notes: optStr(2000) }), input);
  return quotes.createQuote(db, opportunityId, d.validUntil, d.notes);
}

const itemSchema = z.object({
  productId: optUuid, description: optStr(300),
  quantity: z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? 1 : parseQuantity(v)) : v ?? 1), z.number({ invalid_type_error: 'La cantidad debe ser mayor que 0.' }).gt(0, 'La cantidad debe ser mayor que 0.')),
  unitPrice: optMoney, discountPct: percent('El descuento debe estar entre 0 y 100.', 0), taxRate: optPercent,
});
export async function addItem(db: ServerSupabase, quoteId: string, input: unknown) {
  const d = parse(itemSchema, input);
  if (!d.productId && (!d.description || d.unitPrice === undefined)) {
    throw new UserFacingError('Elige un producto del catálogo, o escribe la descripción y el precio de la línea.');
  }
  return quotes.addItem(db, quoteId, d);
}

export async function updateItem(db: ServerSupabase, itemId: string, input: unknown) {
  const d = parse(z.object({
    quantity: itemSchema.shape.quantity, unitPrice: money('Escribe un precio válido.'), discountPct: itemSchema.shape.discountPct, description: optStr(300),
  }), input);
  await quotes.updateItem(db, itemId, d);
}

export async function updateQuoteHeader(db: ServerSupabase, id: string, input: unknown) {
  const d = parse(z.object({ validUntil: dateOnly, notes: optStr(2000) }), input);
  await quotes.updateQuoteHeader(db, id, { valid_until: d.validUntil ?? null, notes: d.notes ?? null });
}

// ---------------------------------------------------------------- casos
export async function openCase(db: ServerSupabase, orgId: string, input: unknown) {
  const d = parse(z.object({
    customerId: z.string().uuid('Cliente no válido.'),
    title: z.string().trim().min(1, 'Describe el problema en pocas palabras.').max(160, 'El título es demasiado largo.'),
    kind: z.enum(['support', 'complaint', 'warranty', 'return', 'question']).default('support'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    description: optStr(2000), saleId: optUuid, assigneeId: optUuid,
  }), input);
  return sales.openCase(db, orgId, d);
}

export async function changeCaseStatus(db: ServerSupabase, id: string, to: string, note?: string) {
  const status = parse(z.enum(['open', 'in_progress', 'resolved', 'closed']), to);
  const n = note?.trim() ?? '';
  if (status === 'resolved' && n.length < 3) throw new UserFacingError('Escribe cómo se resolvió (al menos 3 letras).');
  await sales.setCaseStatus(db, id, status, n || undefined);
}
