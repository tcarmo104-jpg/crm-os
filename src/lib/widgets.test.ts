import { describe, expect, it } from 'vitest';
import { buildPrefilledMessage, buildWhatsAppLink, normalizeDomainList } from './widgets';

describe('normalizeDomainList: limpia lo que alguien escriba a mano sin pensarlo mucho', () => {
  it('quita protocolo, www, barras finales y espacios', () => {
    expect(normalizeDomainList('https://www.arkos.com.co/')).toEqual(['arkos.com.co']);
  });
  it('acepta uno por línea o separados por coma', () => {
    expect(normalizeDomainList('arkos.com.co\narkos.com.mx, otra-tienda.com')).toEqual(['arkos.com.co', 'arkos.com.mx', 'otra-tienda.com']);
  });
  it('no duplica si el mismo dominio aparece dos veces', () => {
    expect(normalizeDomainList('arkos.com.co\nhttps://arkos.com.co')).toEqual(['arkos.com.co']);
  });
  it('líneas vacías no cuentan', () => {
    expect(normalizeDomainList('arkos.com.co\n\n\n')).toEqual(['arkos.com.co']);
  });
});

describe('buildWhatsAppLink: arma el enlace wa.me con el mensaje ya escrito', () => {
  it('deja solo dígitos del número y codifica el mensaje', () => {
    expect(buildWhatsAppLink('+57 300 000 0009', 'Hola, ¿tienen envíos?')).toBe('https://wa.me/573000000009?text=Hola%2C%20%C2%BFtienen%20env%C3%ADos%3F');
  });
});

describe('buildPrefilledMessage: siempre incluye el nombre, para que el asesor sepa quién escribe', () => {
  it('antepone el nombre al mensaje del visitante', () => {
    expect(buildPrefilledMessage('Ana Gómez', 'Quiero más información')).toBe('Hola, soy Ana Gómez. Quiero más información');
  });
  it('sin mensaje, usa un texto por defecto (nunca manda algo vacío)', () => {
    expect(buildPrefilledMessage('Beto', '   ')).toBe('Hola, soy Beto. Hola, quiero más información.');
  });
});
