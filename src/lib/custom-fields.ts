import type { FieldDefinition } from './types';
import { coerceCustomValue } from './csv';

/** "Presupuesto mensual" → "presupuesto_mensual" (cumple ^[a-z][a-z0-9_]{1,39}$ si el resultado es válido). */
export function keyFromLabel(label: string): string {
  const base = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '');
  return /^[a-z]/.test(base) ? base : base ? `campo_${base}`.slice(0, 40) : '';
}

/** Una opción por línea; sin repetidas ni vacías. */
export function parseOptions(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const v = line.trim().slice(0, 100);
    if (v) seen.add(v);
  }
  return [...seen].slice(0, 50);
}

/**
 * Lee los campos personalizados de un formulario (`cf_<clave>`). Solo campos ACTIVOS.
 * Devuelve las actualizaciones: `null` significa "borrar el valor".
 */
export function readCustomFields(fd: FormData, defs: FieldDefinition[]): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const d of defs) {
    if (d.archivedAt) continue;
    const name = `cf_${d.key}`;
    if (d.type === 'multi_select') {
      const list = fd.getAll(name).filter((v): v is string => typeof v === 'string' && v !== '');
      updates[d.key] = list.length > 0 ? list : null;
      continue;
    }
    const raw = fd.get(name);
    if (typeof raw !== 'string') continue;
    updates[d.key] = coerceCustomValue(raw, d.type);
  }
  return updates;
}

/** Aplica las actualizaciones sobre lo existente; `null` elimina la clave. Conserva los campos archivados. */
export function mergeCustomFields(existing: Record<string, unknown>, updates: Record<string, unknown>): Record<string, unknown> {
  const out = { ...existing };
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Nombres de los tipos de campo para la interfaz. */
export const FIELD_TYPE_LABELS = {
  text: 'Texto', number: 'Número', date: 'Fecha', select: 'Lista (una opción)', multi_select: 'Lista (varias opciones)',
  boolean: 'Sí / No', currency: 'Moneda', url: 'Enlace', phone: 'Teléfono', email: 'Correo',
} as const;
