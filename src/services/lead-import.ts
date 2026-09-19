import type { CountryCode } from 'libphonenumber-js/min';
import { mapColumns, parseCsv, coerceCustomValue, MAX_CSV_ROWS, type CoreField } from '@/lib/csv';
import { UserFacingError } from '@/lib/errors';
import type { FieldDefinition } from '@/lib/types';
import { buildIngestPayload, leadInputSchema } from './ingest';

export interface RowResult { row: number; outcome?: string; deduplicated?: boolean; error_code?: string; error?: string | null }
export type Importer = (rows: Record<string, unknown>[]) => Promise<RowResult[]>;

export interface ImportSummary {
  total: number; created: number; matched: number; review: number; conflict: number; failed: number;
  warnings: number; errors: { line: number; message: string }[]; ignoredColumns: string[];
}

const CHUNK = 200;
const MAX_ERRORS_SHOWN = 50;
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

function rowErrorMessage(r: RowResult): string {
  if (r.error_code === '22023') {
    const e = r.error ?? '';
    if (e.includes('contact_required')) return 'Falta un teléfono, correo o usuario de contacto.';
    const key = e.match(/custom_field: (?:unknown field )?([a-z0-9_]+)/)?.[1];
    if (e.includes('custom_field')) return key ? `El campo personalizado «${key}» no es válido.` : 'Un campo personalizado no es válido.';
    return 'Algún dato no es válido.';
  }
  if (r.error_code === '23514') return 'Algún dato no cumple el formato esperado.';
  return 'No se pudo importar esta fila.';
}

/**
 * Importa leads desde un CSV. Cada fila se procesa de forma independiente: una fila mala no afecta a las demás.
 * La normalización de teléfonos/correos ocurre aquí; la base de datos vuelve a validar el formato.
 */
export async function importLeadsCsv(
  text: string,
  opts: { country: CountryCode; fields: FieldDefinition[]; importer: Importer },
): Promise<ImportSummary> {
  const { headers, rows } = parseCsv(text);
  if (headers.length === 0 || rows.length === 0) throw new UserFacingError('El archivo está vacío o no tiene filas de datos.');
  if (rows.length > MAX_CSV_ROWS) throw new UserFacingError(`El archivo tiene ${rows.length} filas. El máximo por importación es ${MAX_CSV_ROWS}.`);

  const leadFields = opts.fields.filter((f) => f.entity === 'lead' && !f.archivedAt);
  const map = mapColumns(headers, leadFields);
  const contactCols: CoreField[] = ['email', 'phone', 'whatsapp', 'instagram', 'facebook'];
  if (!contactCols.some((c) => map.core[c] !== undefined)) {
    throw new UserFacingError('No encontramos ninguna columna de contacto. Incluye al menos una llamada «teléfono», «correo», «whatsapp» o «instagram».');
  }

  const summary: ImportSummary = {
    total: rows.length, created: 0, matched: 0, review: 0, conflict: 0, failed: 0, warnings: 0, errors: [], ignoredColumns: map.ignored,
  };
  const fail = (line: number, message: string) => {
    summary.failed++;
    if (summary.errors.length < MAX_ERRORS_SHOWN) summary.errors.push({ line, message });
  };

  const cell = (row: string[], f: CoreField) => {
    const i = map.core[f];
    const v = i === undefined ? undefined : row[i]?.trim();
    return v ? v : undefined;
  };

  // Construir el lote válido, recordando la línea de cada fila
  const pending: { line: number; payload: Record<string, unknown> }[] = [];
  rows.forEach((row, idx) => {
    const line = idx + 2;
    const first = cell(row, 'name');
    const last = cell(row, 'lastName');
    const custom: Record<string, unknown> = {};
    for (const c of map.custom) {
      const def = leadFields.find((f) => f.key === c.key);
      const v = def ? coerceCustomValue(row[c.index] ?? '', def.type) : null;
      if (v !== null) custom[c.key] = v;
    }
    const parsed = leadInputSchema.safeParse({
      name: [first, last].filter(Boolean).join(' ') || undefined,
      email: cell(row, 'email'), phone: cell(row, 'phone'), whatsapp: cell(row, 'whatsapp'),
      instagram: cell(row, 'instagram'), facebook: cell(row, 'facebook'),
      city: cell(row, 'city'), country: cell(row, 'country'),
      source: cell(row, 'source') ?? 'csv', channel: cell(row, 'channel'), campaign: cell(row, 'campaign'),
      product_interest: cell(row, 'productInterest'), notes: cell(row, 'notes'), external_id: cell(row, 'externalId'),
      custom_fields: Object.keys(custom).length > 0 ? custom : undefined,
    });
    if (!parsed.success) {
      fail(line, parsed.error.issues[0]?.message ?? 'Datos no válidos.');
      return;
    }
    const built = buildIngestPayload(parsed.data, opts.country);
    if (!built.ok) { fail(line, built.message); return; }
    if (built.warnings.length > 0) summary.warnings++;
    pending.push({ line, payload: built.payload });
  });

  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    const results = await opts.importer(chunk.map((c) => c.payload));
    for (const r of results) {
      const item = chunk[r.row];
      if (!item) continue;
      if (r.error_code) { fail(item.line, rowErrorMessage(r)); continue; }
      if (r.outcome === 'created') summary.created++;
      else if (r.outcome === 'review') { summary.created++; summary.review++; }
      else if (r.outcome === 'conflict') { summary.matched++; summary.conflict++; }
      else summary.matched++;
    }
  }
  return summary;
}
