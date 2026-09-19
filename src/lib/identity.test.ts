import { describe, expect, it } from 'vitest';
import { buildIdentifiers, countryFromLocale, nameKey, normalizeEmail, normalizeHandle, normalizePhone } from './identity';

describe('normalizePhone', () => {
  it('lleva distintos formatos colombianos al mismo E.164', () => {
    for (const raw of ['3001112233', '300 111 2233', '(300) 111-2233', '+57 300 111 2233', '57 3001112233', '0057 300 111 2233']) {
      expect(normalizePhone(raw, 'CO'), raw).toBe('+573001112233');
    }
  });
  it('"00" inicial significa "+" (no un código de operador)', () => {
    expect(normalizePhone('00573001112233', 'CO')).toBe('+573001112233');
    expect(normalizePhone('0057 300 111 2233', 'CO')).toBe('+573001112233');
    expect(normalizePhone('0034 612 345 678', 'CO')).toBe('+34612345678');
  });
  it('respeta el país por defecto de la organización', () => {
    expect(normalizePhone('5512345678', 'MX')).toBe('+525512345678');
    expect(normalizePhone('+1 415 555 2671', 'CO')).toBe('+14155552671');
  });
  it('tolera el ".0" que agrega Excel', () => {
    expect(normalizePhone('3001112233.0', 'CO')).toBe('+573001112233');
  });
  it('rechaza números inválidos', () => {
    for (const raw of ['', '123', 'abc', '30011122', '+57 123']) expect(normalizePhone(raw, 'CO'), raw).toBeNull();
  });
});

describe('normalizeEmail / normalizeHandle', () => {
  it('normaliza correos', () => {
    expect(normalizeEmail('  Carlos@X.COM ')).toBe('carlos@x.com');
    expect(normalizeEmail('no-es-correo')).toBeNull();
    expect(normalizeEmail('a b@x.com')).toBeNull();
  });
  it('extrae handles de URLs y @', () => {
    expect(normalizeHandle('@Carlos.R')).toBe('carlos.r');
    expect(normalizeHandle('https://www.instagram.com/Carlos.R/?hl=es')).toBe('carlos.r');
    expect(normalizeHandle('con espacios')).toBeNull();
  });
});

describe('nameKey (espejo de app.normalize_name)', () => {
  it('coincide con los casos de las pruebas SQL', () => {
    expect(nameKey('  Ñandú  RODRÍGUEZ-Pérez ')).toBe('nandu rodriguez perez');
    expect(nameKey('Carlos Rodríguez')).toBe(nameKey('CARLOS  rodriguez'));
  });
  it('une acentos combinados (NFD)', () => {
    expect(nameKey('Rodri\u0301guez Ma\u0301rquez')).toBe('rodriguez marquez');
  });
});

describe('buildIdentifiers', () => {
  it('normaliza, deduplica y reporta problemas', () => {
    const r = buildIdentifiers({ phone: '300 111 2233', whatsapp: '+573001112233', email: 'A@B.co', instagram: '@ana' }, 'CO');
    expect(r.identifiers).toEqual([
      { type: 'phone', value: '+573001112233' },
      { type: 'email', value: 'a@b.co' },
      { type: 'instagram', value: 'ana' },
    ]);
    expect(r.problems).toEqual([]);
  });
  it('un dato inválido genera un problema pero no bloquea los válidos', () => {
    const r = buildIdentifiers({ phone: '123', email: 'a@b.co' }, 'CO');
    expect(r.identifiers).toEqual([{ type: 'email', value: 'a@b.co' }]);
    expect(r.problems).toHaveLength(1);
  });
  it('sin datos válidos no hay identificadores', () => {
    expect(buildIdentifiers({ phone: 'x' }, 'CO').identifiers).toEqual([]);
    expect(buildIdentifiers({}, 'CO')).toEqual({ identifiers: [], problems: [] });
  });
});

describe('countryFromLocale', () => {
  it('deduce el país del locale', () => {
    expect(countryFromLocale('es-CO')).toBe('CO');
    expect(countryFromLocale('es-MX')).toBe('MX');
    expect(countryFromLocale('es')).toBe('CO');
    expect(countryFromLocale(undefined)).toBe('CO');
  });
});
