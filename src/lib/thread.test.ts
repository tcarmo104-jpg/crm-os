import { describe, expect, it } from 'vitest';
import { buildThread, dayLabel, groupByDay, linkify, listTime, mediaKind, visibleBody } from './thread';
import type { MessageRow } from './types';

const msg = (o: Partial<MessageRow> & { id: string; occurredAt: string }): MessageRow => ({
  direction: 'inbound', kind: 'text', body: 'x', status: 'received', error: null, errorCode: null, sentBy: null, meta: {}, ...o,
});

describe('hilo de la conversación', () => {
  it('mezcla mensajes, notas internas y eventos en orden cronológico', () => {
    const t = buildThread(
      [msg({ id: 'm2', occurredAt: '2026-09-19T10:05:00Z', direction: 'outbound', status: 'sent', sentBy: 'u1' }), msg({ id: 'm1', occurredAt: '2026-09-19T10:00:00Z' })],
      [{ id: 'n1', occurredAt: '2026-09-19T10:03:00Z', summary: 'Pidió factura', createdBy: 'u1' }],
      [{ id: 'e1', occurredAt: '2026-09-19T09:59:00Z', text: 'Conversación iniciada' }],
    );
    expect(t.map((i) => i.id)).toEqual(['e1', 'm1', 'n1', 'm2']);
    expect(t.map((i) => i.kind)).toEqual(['event', 'message', 'note', 'message']);
  });
  it('a la misma hora, el evento va primero y la nota al final (orden estable)', () => {
    const at = '2026-09-19T10:00:00Z';
    const t = buildThread([msg({ id: 'b', occurredAt: at })], [{ id: 'a', occurredAt: at, summary: 's', createdBy: null }], [{ id: 'c', occurredAt: at, text: 't' }]);
    expect(t.map((i) => i.kind)).toEqual(['event', 'message', 'note']);
  });
  it('un saliente sin autor humano es «automático»; uno con autor no; los entrantes nunca', () => {
    const [bot, humano, cliente] = buildThread([
      msg({ id: '1', occurredAt: '2026-09-19T10:00:00Z', direction: 'outbound', status: 'sent', sentBy: null }),
      msg({ id: '2', occurredAt: '2026-09-19T10:01:00Z', direction: 'outbound', status: 'sent', sentBy: 'u1' }),
      msg({ id: '3', occurredAt: '2026-09-19T10:02:00Z' }),
    ], [], []) as Extract<ReturnType<typeof buildThread>[number], { kind: 'message' }>[];
    expect([bot!.auto, humano!.auto, cliente!.auto]).toEqual([true, false, false]);
  });
  it('reconoce plantillas y el tipo de adjunto', () => {
    expect(mediaKind({ kind: 'media', meta: { type: 'image' } })).toBe('image');
    expect(mediaKind({ kind: 'media', meta: { type: 'document' } })).toBe('document');
    expect(mediaKind({ kind: 'media', meta: { type: 'raro' } })).toBe('other');
    expect(mediaKind({ kind: 'media', meta: {} })).toBe('other');
    expect(mediaKind({ kind: 'text', meta: { type: 'image' } })).toBeNull();
    const [t] = buildThread([msg({ id: 't', occurredAt: '2026-09-19T10:00:00Z', kind: 'template', direction: 'outbound', status: 'sent', sentBy: 'u' })], [], []);
    expect((t as { template: boolean }).template).toBe(true);
  });
  it('agrupa por día en la zona horaria de la organización (Hoy / Ayer / fecha)', () => {
    const now = new Date('2026-09-19T15:00:00Z');       // 10:00 en Bogotá
    expect(dayLabel('2026-09-19T14:00:00Z', 'America/Bogota', now)).toBe('Hoy');
    expect(dayLabel('2026-09-18T14:00:00Z', 'America/Bogota', now)).toBe('Ayer');
    expect(dayLabel('2026-09-10T14:00:00Z', 'America/Bogota', now)).toBe('10 de septiembre de 2026');
    // 02:00 UTC del día 19 sigue siendo el día 18 en Bogotá (UTC-5): es «Ayer», no «Hoy»
    expect(dayLabel('2026-09-19T02:00:00Z', 'America/Bogota', now)).toBe('Ayer');
    const groups = groupByDay(buildThread([
      msg({ id: 'a', occurredAt: '2026-09-18T14:00:00Z' }), msg({ id: 'b', occurredAt: '2026-09-18T15:00:00Z' }), msg({ id: 'c', occurredAt: '2026-09-19T14:00:00Z' }),
    ], [], []), 'America/Bogota', now);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([['Ayer', 2], ['Hoy', 1]]);
  });
});

describe('enlaces en los mensajes', () => {
  it('detecta http(s) sin arrastrar la puntuación final', () => {
    expect(linkify('Mira https://ejemplo.com/a?b=1, gracias.')).toEqual([
      { t: 'text', v: 'Mira ' }, { t: 'link', v: 'https://ejemplo.com/a?b=1' }, { t: 'text', v: ', gracias.' },
    ]);
    expect(linkify('(ver http://x.co/y)')).toEqual([{ t: 'text', v: '(ver ' }, { t: 'link', v: 'http://x.co/y' }, { t: 'text', v: ')' }]);
  });
  it('sin enlaces devuelve el texto tal cual; nunca interpreta otros esquemas ni HTML', () => {
    expect(linkify('hola')).toEqual([{ t: 'text', v: 'hola' }]);
    expect(linkify('')).toEqual([{ t: 'text', v: '' }]);
    for (const bad of ['javascript:alert(1)', 'data:text/html;base64,AAA', '<a href="https://x.co">x</a>', 'ftp://x.co']) {
      const links = linkify(bad).filter((p) => p.t === 'link').map((p) => p.v);
      for (const l of links) expect(l).toMatch(/^https?:\/\/[^\s<>"']+$/);
    }
    expect(linkify('<img src=x onerror=alert(1)>').every((p) => p.t === 'text')).toBe(true);
  });
  it('varios enlaces seguidos', () => {
    expect(linkify('https://a.co https://b.co').filter((p) => p.t === 'link').map((p) => p.v)).toEqual(['https://a.co', 'https://b.co']);
  });
});

describe('hora en la lista de conversaciones', () => {
  const now = new Date('2026-09-19T15:00:00Z');
  it('hoy hora, ayer «Ayer», antes día/mes; vacío si no hay fecha', () => {
    expect(listTime('2026-09-19T14:05:00Z', 'America/Bogota', now)).toBe('09:05');
    expect(listTime('2026-09-18T14:05:00Z', 'America/Bogota', now)).toBe('Ayer');
    expect(listTime('2026-09-12T14:05:00Z', 'America/Bogota', now)).toBe('12/09');
    expect(listTime(null, 'America/Bogota', now)).toBe('');
  });
});

describe('visibleBody: la etiqueta automática no se repite cuando el adjunto ya se ve', () => {
  it('quita «[Imagen]», «[Documento: x]», «[Ubicación: x]» y «[Contacto compartido]» solo si hay adjuntos', () => {
    for (const b of ['[Imagen]', '[Video]', '[Audio]', '[Sticker]', '[Documento: plano.pdf]', '[Ubicación: Oficina]', '[Ubicación]', '[Contacto compartido]', '[Archivo]', '[Mención en una historia]']) {
      expect(visibleBody(b, true)).toBe(''); expect(visibleBody(b, false)).toBe(b);
    }
  });
  it('conserva el pie de foto del cliente y el texto del correo', () => {
    expect(visibleBody('[Imagen] Mira esto', true)).toBe('Mira esto');
    expect(visibleBody('[Documento: plano.pdf] Te lo envío hoy', true)).toBe('Te lo envío hoy');
    expect(visibleBody('Cotización\n\nAdjunto planos\n[2 adjuntos]', true)).toBe('Cotización\n\nAdjunto planos');
    expect(visibleBody('Cotización\n\nAdjunto planos\n[1 adjunto]', true)).toBe('Cotización\n\nAdjunto planos');
    expect(visibleBody('[3 adjuntos] mira', true)).toBe('mira');
  });
  it('no toca un texto normal que casualmente contiene corchetes', () => {
    expect(visibleBody('Ver [Imagen] adjunta abajo', true)).toBe('Ver [Imagen] adjunta abajo');
    expect(visibleBody('hola', true)).toBe('hola');
  });
});
