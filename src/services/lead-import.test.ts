import { describe, expect, it } from 'vitest';
import { importLeadsCsv, type Importer } from './lead-import';
import type { FieldDefinition } from '@/lib/types';

const fields: FieldDefinition[] = [
  { id: '1', entity: 'lead', key: 'presupuesto', label: 'Presupuesto', type: 'number', options: [], position: 0, archivedAt: null },
];
/** Importador falso: registra lo recibido y responde "created" (o lo que indique `respond`). */
const fake = (respond?: (payload: Record<string, unknown>, i: number) => Record<string, unknown>) => {
  const received: Record<string, unknown>[][] = [];
  const importer: Importer = async (rows) => {
    received.push(rows);
    return rows.map((p, i) => ({ row: i, outcome: 'created', ...(respond?.(p, i) ?? {}) }));
  };
  return { importer, received };
};

describe('importLeadsCsv', () => {
  it('importa, normaliza teléfonos y arma el payload', async () => {
    const { importer, received } = fake();
    const s = await importLeadsCsv('Nombre;Apellido;Teléfono;Correo;Ciudad;Presupuesto\nAna;Ruiz;300 111 2233;ANA@x.com;Cali;1500,5\n',
      { country: 'CO', fields, importer });
    expect(s).toMatchObject({ total: 1, created: 1, failed: 0 });
    const p = received[0]![0]!;
    expect(p.name).toBe('Ana Ruiz');
    expect(p.identifiers).toEqual([{ type: 'phone', value: '+573001112233' }, { type: 'email', value: 'ana@x.com' }]);
    expect(p.custom_fields).toEqual({ presupuesto: 1500.5 });
    expect(p.source).toBe('csv');
  });

  it('filas sin contacto válido fallan con su línea, sin llamar a la BD y sin afectar a las demás', async () => {
    const { importer, received } = fake();
    const s = await importLeadsCsv('nombre,telefono,correo\nAna,300 111 2233,\nSin datos,,\nMal,123,\n', { country: 'CO', fields, importer });
    expect(received[0]).toHaveLength(1);
    expect(s).toMatchObject({ total: 3, created: 1, failed: 2 });
    expect(s.errors.map((e) => e.line)).toEqual([3, 4]);
    expect(s.errors[1]!.message).toMatch(/Teléfono no válido/);
  });

  it('cuenta creados, existentes, revisiones y conflictos; traduce los errores de la BD', async () => {
    const outcomes = ['created', 'matched', 'review', 'conflict', 'created'];
    const { importer } = fake((_p, i) => (i === 4 ? { outcome: undefined, error_code: '22023', error: 'custom_field: presupuesto must be a number' } : { outcome: outcomes[i] }));
    const csv = 'correo\n' + outcomes.map((_, i) => `p${i}@x.com`).join('\n');
    const s = await importLeadsCsv(csv, { country: 'CO', fields, importer });
    expect(s).toMatchObject({ created: 2, matched: 2, review: 1, conflict: 1, failed: 1 });
    expect(s.errors[0]!.message).toBe('El campo personalizado «presupuesto» no es válido.');
  });

  it('procesa en lotes de 200', async () => {
    const { importer, received } = fake();
    const csv = 'correo\n' + Array.from({ length: 450 }, (_, i) => `p${i}@x.com`).join('\n');
    await importLeadsCsv(csv, { country: 'CO', fields, importer });
    expect(received.map((r) => r.length)).toEqual([200, 200, 50]);
  });

  it('errores globales claros', async () => {
    const { importer } = fake();
    await expect(importLeadsCsv('', { country: 'CO', fields, importer })).rejects.toThrow(/vacío/);
    await expect(importLeadsCsv('nombre,ciudad\nAna,Cali', { country: 'CO', fields, importer })).rejects.toThrow(/columna de contacto/);
    await expect(importLeadsCsv('correo\n' + 'a@b.co\n'.repeat(5001), { country: 'CO', fields, importer })).rejects.toThrow(/máximo/);
  });

  it('informa las columnas ignoradas', async () => {
    const { importer } = fake();
    const s = await importLeadsCsv('correo,Color favorito\na@b.co,azul', { country: 'CO', fields, importer });
    expect(s.ignoredColumns).toEqual(['Color favorito']);
  });
});
