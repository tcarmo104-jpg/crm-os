import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv: arma un CSV de salida válido a partir de encabezados y filas (para exportar reportes)', () => {
  it('separa por comas y termina cada línea con retorno de carro', () => {
    const csv = toCsv(['Nombre', 'Monto'], [['Ana', 100], ['Beto', 200]]);
    expect(csv).toBe('Nombre,Monto\r\nAna,100\r\nBeto,200');
  });
  it('envuelve en comillas un valor que tiene coma, comilla o salto de línea, y duplica las comillas internas', () => {
    const csv = toCsv(['Nota'], [['Dice "hola", adiós']]);
    expect(csv).toBe('Nota\r\n"Dice ""hola"", adiós"');
  });
  it('sin filas, deja solo el encabezado', () => {
    expect(toCsv(['A', 'B'], [])).toBe('A,B');
  });
});
