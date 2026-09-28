import { describe, expect, it } from 'vitest';
import { ACTION_LABEL, CRUD_ACTIONS, CRUD_MODULES, isValidRoleKey, MODULE_LABEL, SCOPE_LABEL, slugifyRoleKey, SPECIAL_PERMISSIONS, SPECIAL_PERMISSION_LABEL } from './roles';

describe('catálogo de permisos: todo módulo, acción y permiso especial tiene una etiqueta legible', () => {
  it('los 9 módulos y las 4 acciones tienen etiqueta', () => {
    for (const m of CRUD_MODULES) expect(MODULE_LABEL[m]).toBeTruthy();
    for (const a of CRUD_ACTIONS) expect(ACTION_LABEL[a]).toBeTruthy();
  });
  it('los permisos especiales tienen etiqueta', () => {
    for (const p of SPECIAL_PERMISSIONS) expect(SPECIAL_PERMISSION_LABEL[p]).toBeTruthy();
  });
  it('los 3 alcances tienen etiqueta', () => {
    expect(SCOPE_LABEL.own).toBe('Lo propio'); expect(SCOPE_LABEL.team).toBe('Su equipo'); expect(SCOPE_LABEL.org).toBe('Toda la organización');
  });
});

describe('isValidRoleKey: la misma regla que ya exige la base de datos', () => {
  it('acepta minúsculas y guion bajo', () => { expect(isValidRoleKey('vendedor_junior')).toBe(true); });
  it('rechaza mayúsculas, espacios, tildes o muy corto', () => {
    expect(isValidRoleKey('Vendedor')).toBe(false);
    expect(isValidRoleKey('vendedor junior')).toBe(false);
    expect(isValidRoleKey('vendedór')).toBe(false);
    expect(isValidRoleKey('a')).toBe(false);
  });
});

describe('slugifyRoleKey: convierte un nombre escrito en una clave técnica válida', () => {
  it('quita tildes, pasa a minúsculas y usa guion bajo', () => {
    expect(slugifyRoleKey('Vendedor Júnior')).toBe('vendedor_junior');
  });
  it('el resultado siempre es una clave válida para un nombre razonable', () => {
    expect(isValidRoleKey(slugifyRoleKey('Coordinador de Ventas Norte'))).toBe(true);
    expect(slugifyRoleKey('Coordinador de Ventas Norte')).toBe('coordinador_de_ventas_norte');
  });
});
