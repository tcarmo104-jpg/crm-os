import { describe, expect, it } from 'vitest';
import { mergeWidgetFields, renderMessageTemplate, type WidgetConfigField } from './widget-fields';

const f = (key: string, extra: Partial<WidgetConfigField> = {}): WidgetConfigField => ({
  fieldId: key, key, type: 'text', label: key, placeholder: null, options: [], required: false, defaultValue: null, ...extra,
});

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

describe('mergeWidgetFields: el formulario base + lo propio de la intención elegida (Entrega 4)', () => {
  it('sin intención (extra vacío), el formulario es solo el base', () => {
    expect(mergeWidgetFields([f('producto')], [])).toEqual([f('producto')]);
  });
  it('las preguntas de la intención se SUMAN al final, no reemplazan el formulario base', () => {
    expect(mergeWidgetFields([f('empresa')], [f('cantidad')])).toEqual([f('empresa'), f('cantidad')]);
  });
  it('si la intención repite una clave del formulario base, la de la intención manda para esa clave (misma posición)', () => {
    const base = f('producto', { required: false, label: 'Producto' });
    const override = f('producto', { required: true, label: 'Qué producto quieres' });
    expect(mergeWidgetFields([base], [override])).toEqual([override]);
  });
  it('sin formulario base ni intención, el resultado es un formulario vacío (el script cae al mensaje libre de siempre)', () => {
    expect(mergeWidgetFields([], [])).toEqual([]);
  });
});
