import { describe, expect, it } from 'vitest';
import { formatMoney, parseAmount, parsePercent, parseQuantity } from './money';

describe('parseAmount', () => {
  it('formatos habituales en español e inglés', () => {
    const cases: [string, number][] = [
      ['1500000', 1500000], ['1.500.000', 1500000], ['1,500,000', 1500000], ['$ 1.500.000', 1500000],
      ['1.500.000,50', 1500000.5], ['1,500,000.50', 1500000.5], ['12,5', 12.5], ['12.5', 12.5],
      ['1.500', 1500], ['1,500', 1500], ['0.500', 0.5], ['0,5', 0.5], ['COP 2 000', 2000], ['0', 0],
    ];
    for (const [raw, n] of cases) expect(parseAmount(raw), raw).toBe(n);
  });
  it('rechaza lo que no es un monto válido', () => {
    for (const raw of ['', 'abc', '-5', '1-2', '1.2.3,4,5', '$', '99999999999999']) expect(parseAmount(raw), raw).toBeNull();
  });
  it('redondea a 2 decimales', () => {
    expect(parseAmount('10,999')).toBe(10999);   // 3 dígitos tras un único separador = miles
    expect(parseAmount('10,9999')).toBe(11);          // decimal (4 dígitos), redondeado a 2 decimales
  });
});

describe('formatMoney', () => {
  it('formatea con la moneda de la organización', () => {
    expect(formatMoney(1500000, 'COP', 'es-CO')).toMatch(/1\.500\.000/);
    expect(formatMoney(12.5, 'USD', 'en-US')).toBe('$12.50');
  });
  it('una moneda inválida no rompe la pantalla', () => {
    expect(() => formatMoney(10, 'xx')).not.toThrow();
  });
});

describe('parsePercent / parseQuantity', () => {
  it('porcentajes', () => {
    expect(parsePercent('19')).toBe(19);
    expect(parsePercent('19,5 %')).toBe(19.5);
    expect(parsePercent('0')).toBe(0);
    for (const bad of ['', 'abc', '101', '-1', '5%%%']) expect(parsePercent(bad), bad).toBeNull();
  });
  it('cantidades', () => {
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('2,5')).toBe(2.5);
    expect(parseQuantity('0.3339')).toBe(0.334);
    for (const bad of ['', '0', '-3', 'x', '2000000']) expect(parseQuantity(bad), bad).toBeNull();
  });
});

