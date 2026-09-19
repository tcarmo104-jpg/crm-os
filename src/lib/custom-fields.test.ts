import { describe, expect, it } from 'vitest';
import { keyFromLabel, mergeCustomFields, parseOptions, readCustomFields } from './custom-fields';
import type { FieldDefinition } from './types';

const def = (key: string, type: FieldDefinition['type'], archivedAt: string | null = null): FieldDefinition =>
  ({ id: key, entity: 'customer', key, label: key, type, options: [], position: 0, archivedAt });

describe('keyFromLabel', () => {
  it('genera claves válidas', () => {
    expect(keyFromLabel('Presupuesto mensual')).toBe('presupuesto_mensual');
    expect(keyFromLabel('  ¿Tiene Mascota? ')).toBe('tiene_mascota');
    expect(keyFromLabel('2do contacto')).toBe('campo_2do_contacto');
    expect(keyFromLabel('!!!')).toBe('');
    expect(keyFromLabel('x'.repeat(80)).length).toBeLessThanOrEqual(40);
  });
  it('el resultado cumple el formato que exige la BD', () => {
    for (const l of ['Nivel', 'Año de ingreso', '9 vidas', 'A B C']) {
      const k = keyFromLabel(l);
      if (k) expect(k, l).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
    }
  });
});

describe('parseOptions', () => {
  it('una por línea, sin vacías ni repetidas', () => {
    expect(parseOptions('Oro\n\n Plata \r\nOro\nBronce')).toEqual(['Oro', 'Plata', 'Bronce']);
    expect(parseOptions('')).toEqual([]);
  });
});

describe('readCustomFields / mergeCustomFields', () => {
  const defs = [def('edad', 'number'), def('vip', 'boolean'), def('gustos', 'multi_select'), def('nota', 'text'), def('viejo', 'text', '2026-01-01')];

  it('convierte según el tipo y usa null para borrar', () => {
    const fd = new FormData();
    fd.set('cf_edad', '33'); fd.set('cf_vip', 'true'); fd.append('cf_gustos', 'a'); fd.append('cf_gustos', 'b'); fd.set('cf_nota', '  ');
    fd.set('cf_viejo', 'no debe leerse');
    expect(readCustomFields(fd, defs)).toEqual({ edad: 33, vip: true, gustos: ['a', 'b'], nota: null });
  });
  it('multi_select sin selección borra el valor', () => {
    expect(readCustomFields(new FormData(), defs).gustos).toBeNull();
  });
  it('merge aplica cambios, borra con null y conserva los campos archivados', () => {
    expect(mergeCustomFields({ edad: 30, viejo: 'x', nota: 'hola' }, { edad: 31, nota: null, vip: false }))
      .toEqual({ edad: 31, viejo: 'x', vip: false });
  });
});
