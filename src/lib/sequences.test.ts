import { describe, expect, it } from 'vitest';
import { offsetLabel, SEQUENCE_STEP_TYPES, SEQUENCE_STEP_TYPE_ICON, SEQUENCE_STEP_TYPE_LABEL } from './sequences';

describe('offsetLabel: cómo se explica cuándo cae un paso', () => {
  it('el mismo día, 1 día, o N días', () => {
    expect(offsetLabel(0)).toBe('El mismo día');
    expect(offsetLabel(1)).toBe('1 día después');
    expect(offsetLabel(5)).toBe('5 días después');
  });
});

describe('catálogo de tipos de paso: comparte tipos e iconos con Tareas (un solo tipo de dato)', () => {
  it('todo tipo tiene etiqueta e icono', () => {
    for (const t of SEQUENCE_STEP_TYPES) { expect(SEQUENCE_STEP_TYPE_LABEL[t]).toBeTruthy(); expect(SEQUENCE_STEP_TYPE_ICON[t]).toBeTruthy(); }
  });
});
