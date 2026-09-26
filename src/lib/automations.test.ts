import { describe, expect, it } from 'vitest';
import { AUTOMATION_TRIGGERS, describeAction, describeCondition, TRIGGER_FIELDS, TRIGGER_LABEL } from './automations';

describe('catálogo de disparadores: todos tienen etiqueta y campos disponibles para condiciones', () => {
  it('todo disparador tiene etiqueta y al menos un campo', () => {
    for (const t of AUTOMATION_TRIGGERS) { expect(TRIGGER_LABEL[t]).toBeTruthy(); expect(TRIGGER_FIELDS[t].length).toBeGreaterThan(0); }
  });
});

describe('describeCondition: texto legible, sin que la persona lea JSON', () => {
  it('arma «campo es [operador] valor»', () => {
    expect(describeCondition({ field: 'source', op: 'eq', value: 'feria' })).toBe('source es igual a «feria»');
    expect(describeCondition({ field: 'amount', op: 'gte', value: '10000000' })).toBe('amount es mayor o igual que «10000000»');
  });
});

describe('describeAction: una frase por cada tipo de acción', () => {
  it('crear tarea y agregar etiqueta muestran su detalle', () => {
    expect(describeAction({ type: 'create_task', title: 'Llamar' })).toBe('Crear tarea «Llamar»');
    expect(describeAction({ type: 'add_tag', name: 'VIP' })).toBe('Agregar la etiqueta «VIP»');
  });
  it('asignar responsable e inscribir en secuencia tienen su propio texto fijo', () => {
    expect(describeAction({ type: 'assign_owner' })).toBe('Asignar un responsable');
    expect(describeAction({ type: 'enroll_sequence' })).toBe('Inscribir en una secuencia');
  });
});
