import { describe, expect, it } from 'vitest';
import { coerceCustomValue, decodeCsvBuffer, detectDelimiter, mapColumns, normalizeHeader, parseCsv } from './csv';

describe('parseCsv', () => {
  it('lee CSV simple con CRLF, BOM y líneas vacías', () => {
    const r = parseCsv('\uFEFFnombre,correo\r\nAna,ana@x.com\r\n\r\nBeto,beto@x.com\r\n');
    expect(r.headers).toEqual(['nombre', 'correo']);
    expect(r.rows).toEqual([['Ana', 'ana@x.com'], ['Beto', 'beto@x.com']]);
  });
  it('detecta punto y coma (Excel latino) y tabulador', () => {
    expect(parseCsv('nombre;telefono\nAna;300 111 2233').rows).toEqual([['Ana', '300 111 2233']]);
    expect(parseCsv('nombre\ttelefono\nAna\t300').rows).toEqual([['Ana', '300']]);
    expect(detectDelimiter('a;b;c,d')).toBe(';');
  });
  it('maneja comillas, comas y saltos de línea dentro de un campo', () => {
    const r = parseCsv('nombre,notas\n"Pérez, Ana","Dijo ""hola""\ny colgó"\nBeto,ok');
    expect(r.rows).toEqual([['Pérez, Ana', 'Dijo "hola"\ny colgó'], ['Beto', 'ok']]);
  });
  it('sin salto de línea final y con celdas vacías', () => {
    expect(parseCsv('a,b,c\n1,,3').rows).toEqual([['1', '', '3']]);
  });
  it('archivo vacío', () => {
    expect(parseCsv('')).toMatchObject({ headers: [], rows: [] });
  });
  it('un valor con "=" o "+" al inicio no se interpreta (sin fórmulas): se conserva como texto', () => {
    expect(parseCsv('nombre\n=HYPERLINK("x")').rows[0]?.[0]).toBe('=HYPERLINK("x")');
  });
});

describe('mapColumns', () => {
  it('reconoce alias en español/inglés sin importar acentos ni mayúsculas', () => {
    const m = mapColumns(['Nombre', 'Correo electrónico', 'Teléfono', 'Ciudad', 'Campaña', 'Producto de interés', 'Otra']);
    expect(m.core).toMatchObject({ name: 0, email: 1, phone: 2, city: 3, campaign: 4 });
    expect(m.ignored).toEqual(['Producto de interés', 'Otra']);
    expect(normalizeHeader('Producto de interés')).toBe('productodeinteres');
  });
  it('mapea columnas a campos personalizados por clave o etiqueta', () => {
    const m = mapColumns(['nombre', 'Presupuesto', 'nivel_cliente'], [
      { key: 'presupuesto', label: 'Presupuesto' }, { key: 'nivel', label: 'Nivel cliente' }]);
    expect(m.custom).toEqual([{ key: 'presupuesto', index: 1 }, { key: 'nivel', index: 2 }]);
    expect(m.ignored).toEqual([]);
  });
  it('cuando hay dos columnas candidatas usa la primera y reporta la otra como ignorada', () => {
    const m = mapColumns(['telefono', 'celular']);
    expect(m.core.phone).toBe(0);
    expect(m.ignored).toEqual(['celular']);
  });
});

describe('coerceCustomValue', () => {
  it('números con coma o punto decimal', () => {
    expect(coerceCustomValue('1500,50', 'number')).toBe(1500.5);
    expect(coerceCustomValue('1,500.50', 'currency')).toBe(1500.5);
    expect(coerceCustomValue('abc', 'number')).toBe('abc');   // la BD lo rechazará con un mensaje claro
  });
  it('booleanos, multi_select y vacíos', () => {
    expect(coerceCustomValue('Sí', 'boolean')).toBe(true);
    expect(coerceCustomValue('no', 'boolean')).toBe(false);
    expect(coerceCustomValue('a; b|c', 'multi_select')).toEqual(['a', 'b', 'c']);
    expect(coerceCustomValue('  ', 'text')).toBeNull();
  });
});

describe('decodeCsvBuffer', () => {
  const buf = (b: number[]) => new Uint8Array(b).buffer;
  it('lee UTF-8', () => {
    expect(decodeCsvBuffer(new TextEncoder().encode('Peña,ñandú').buffer)).toBe('Peña,ñandú');
  });
  it('lee Windows-1252 (Excel) sin romper acentos', () => {
    // "Peña" en Windows-1252: 50 65 F1 61
    expect(decodeCsvBuffer(buf([0x50, 0x65, 0xf1, 0x61]))).toBe('Peña');
  });
  it('rechaza binarios (.xlsx es un ZIP)', () => {
    expect(decodeCsvBuffer(buf([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBeNull();
    expect(decodeCsvBuffer(buf([0x61, 0x00, 0x62]))).toBeNull();
  });
});
