import { describe, expect, it } from 'vitest';
import { renderMessageTemplate } from './widget-fields';

describe('renderMessageTemplate', () => {
  it('sustituye las variables presentes', () => {
    expect(renderMessageTemplate('Hola, soy {{nombre}}. Quiero {{producto}}.', { nombre: 'Juan', producto: 'Arkodeck' }))
      .toBe('Hola, soy Juan. Quiero Arkodeck.');
  });

  it('quita una variable sin valor en vez de dejar texto vacío o "undefined"', () => {
    expect(renderMessageTemplate('Hola {{nombre}}, ciudad: {{ciudad}}.', { nombre: 'Ana' })).toBe('Hola Ana, ciudad: .');
  });

  it('no es sensible a mayúsculas ni a espacios dentro de las llaves', () => {
    expect(renderMessageTemplate('{{ Nombre }} - {{NOMBRE}}', { nombre: 'Lu' })).toBe('Lu - Lu');
  });

  it('recorta líneas en blanco de más que dejan las variables vacías', () => {
    expect(renderMessageTemplate('Hola {{nombre}}.\n{{mensaje}}\nGracias.', { nombre: 'Eli' })).toBe('Hola Eli.\n\nGracias.');
  });

  it('un texto sin variables se devuelve igual (solo recortado)', () => {
    expect(renderMessageTemplate('  Hola, quiero más información.  ', {})).toBe('Hola, quiero más información.');
  });

  it('una variable que no está en la lista conocida también se sustituye si viene en los valores', () => {
    expect(renderMessageTemplate('{{origen}}', { origen: 'Google Ads' })).toBe('Google Ads');
  });
});
