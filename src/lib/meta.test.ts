import { describe, expect, it } from 'vitest';
import {
  buildTemplatePayload, buildTextPayload, describeSendError, parseWebhook, signBody, verifyChallenge, verifySignature,
} from './meta';

const SECRET = 'app-secret-de-prueba-123456';
const PID = '109876543210';

const wrap = (value: Record<string, unknown>, field = 'messages') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: PID }, ...value } }] }],
});
const msg = (extra: Record<string, unknown>) => ({ from: '573101112233', id: 'wamid.A', timestamp: '1758300000', ...extra });

describe('firma de Meta (X-Hub-Signature-256)', () => {
  const body = JSON.stringify(wrap({ messages: [msg({ type: 'text', text: { body: 'Hola' } })] }));
  it('acepta la firma correcta del cuerpo crudo', () => {
    expect(verifySignature(body, signBody(body, SECRET), SECRET)).toBe(true);
  });
  it('rechaza cuerpo alterado, secreto distinto, cabecera ausente o mal formada', () => {
    const sig = signBody(body, SECRET);
    expect(verifySignature(body + ' ', sig, SECRET)).toBe(false);
    expect(verifySignature(body, sig, SECRET + 'x')).toBe(false);
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, '', SECRET)).toBe(false);
    expect(verifySignature(body, sig.replace('sha256=', ''), SECRET)).toBe(false);
    expect(verifySignature(body, 'sha1=' + sig.slice(7), SECRET)).toBe(false);
    expect(verifySignature(body, sig.slice(0, -2), SECRET)).toBe(false);          // longitud distinta
    expect(verifySignature(body, sig + 'ab', SECRET)).toBe(false);
    expect(verifySignature(body, 'sha256=' + 'z'.repeat(64), SECRET)).toBe(false); // no hexadecimal
  });
  it('sin secreto configurado (o demasiado corto) NADA es válido, ni siquiera una firma «correcta»', () => {
    expect(verifySignature(body, signBody(body, ''), '')).toBe(false);
    expect(verifySignature(body, signBody(body, 'corto'), 'corto')).toBe(false);
    expect(verifySignature(body, signBody(body, SECRET), undefined)).toBe(false);
  });
  it('un espacio o salto de línea invisible en el secreto guardado (al copiar/pegar) no rompe la firma', () => {
    expect(verifySignature(body, signBody(body, SECRET), SECRET + '\n')).toBe(true);
    expect(verifySignature(body, signBody(body, SECRET), '  ' + SECRET + ' ')).toBe(true);
  });
  it('la firma depende de los BYTES exactos (acentos, espacios)', () => {
    const a = '{"t":"Compañía"}';
    expect(verifySignature(a, signBody(a, SECRET), SECRET)).toBe(true);
    expect(verifySignature('{"t": "Compañía"}', signBody(a, SECRET), SECRET)).toBe(false);
  });
});

describe('verificación del webhook (GET)', () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);
  it('devuelve el challenge solo con modo y token correctos', () => {
    expect(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-largo-123', 'hub.challenge': '1158201444' }), 'token-largo-123')).toBe('1158201444');
    expect(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'otro-token-123', 'hub.challenge': '1' }), 'token-largo-123')).toBeNull();
    expect(verifyChallenge(q({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'token-largo-123', 'hub.challenge': '1' }), 'token-largo-123')).toBeNull();
    expect(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-largo-123' }), 'token-largo-123')).toBeNull();
    expect(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.challenge': '1' }), 'token-largo-123')).toBeNull();
  });
  it('un espacio o salto de línea invisible en el token guardado (al pegar en Vercel) no rompe el saludo', () => {
    const p = q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'Arkos2025*', 'hub.challenge': '12345' });
    expect(verifyChallenge(p, 'Arkos2025*')).toBe('12345');
    expect(verifyChallenge(p, 'Arkos2025* ')).toBe('12345');
    expect(verifyChallenge(p, 'Arkos2025*\n')).toBe('12345');
    expect(verifyChallenge(p, 'arkos2025*')).toBeNull();                       // sigue distinguiendo mayúsculas
  });
  it('sin token configurado (o corto) no verifica; y un challenge con caracteres raros se rechaza (no se refleja)', () => {
    expect(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' }), undefined)).toBeNull();
    expect(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'corto', 'hub.challenge': '1' }), 'corto')).toBeNull();
    expect(verifyChallenge(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-largo-123', 'hub.challenge': '<script>alert(1)</script>' }), 'token-largo-123')).toBeNull();
  });
});

describe('lectura de mensajes entrantes', () => {
  it('texto, con el nombre del perfil, el canal y la hora en ISO', () => {
    const r = parseWebhook(wrap({ contacts: [{ profile: { name: 'Laura Gómez' }, wa_id: '573101112233' }], messages: [msg({ type: 'text', text: { body: 'Hola, ¿tienen sillas?' } })] }));
    expect(r.statuses).toEqual([]);
    expect(r.messages).toEqual([{
      phoneNumberId: PID, thread: '573101112233', contactName: 'Laura Gómez', externalId: 'wamid.A', kind: 'text',
      body: 'Hola, ¿tienen sillas?', occurredAt: '2025-09-19T16:40:00.000Z', meta: {},
    }]);
  });
  it('un lote con varios mensajes y varios contactos asigna cada nombre a su número', () => {
    const r = parseWebhook(wrap({
      contacts: [{ profile: { name: 'Ana' }, wa_id: '573001110001' }, { profile: { name: 'Beto' }, wa_id: '573001110002' }],
      messages: [msg({ id: 'w1', from: '573001110002', type: 'text', text: { body: 'b' } }), msg({ id: 'w2', from: '573001110001', type: 'text', text: { body: 'a' } })],
    }));
    expect(r.messages.map((m) => [m.externalId, m.contactName])).toEqual([['w1', 'Beto'], ['w2', 'Ana']]);
  });
  it('adjuntos: etiqueta legible + pie de foto + referencia al archivo (sin descargarlo)', () => {
    const r = parseWebhook(wrap({ messages: [
      msg({ id: 'i', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'Así la quiero' } }),
      msg({ id: 'd', type: 'document', document: { id: 'MEDIA2', filename: 'cotización.pdf' } }),
      msg({ id: 'a', type: 'audio', audio: { id: 'MEDIA3' } }),
      msg({ id: 's', type: 'sticker', sticker: { id: 'MEDIA4' } }),
    ] }));
    expect(r.messages.map((m) => m.body)).toEqual(['[Imagen] Así la quiero', '[Documento: cotización.pdf]', '[Audio]', '[Sticker]']);
    expect(r.messages[0]).toMatchObject({ kind: 'media', meta: { type: 'image', media_id: 'MEDIA1', mime_type: 'image/jpeg' } });
  });
  it('respuestas a botones y listas se leen como texto; ubicación, contactos y tipos raros se etiquetan', () => {
    const r = parseWebhook(wrap({ messages: [
      msg({ id: '1', type: 'button', button: { text: 'Sí, confirmo', payload: 'CONFIRM' } }),
      msg({ id: '2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Cotizar' } } }),
      msg({ id: '3', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'l1', title: 'Sillas' } } }),
      msg({ id: '4', type: 'location', location: { latitude: 1, longitude: 2, name: 'Bodega norte' } }),
      msg({ id: '5', type: 'contacts', contacts: [{}] }),
      msg({ id: '6', type: 'order' }),
      msg({ id: '7', type: 'unsupported' }),
    ] }));
    expect(r.messages.map((m) => [m.kind, m.body])).toEqual([
      ['text', 'Sí, confirmo'], ['text', 'Cotizar'], ['text', 'Sillas'], ['other', '[Ubicación: Bodega norte]'],
      ['other', '[Contacto compartido]'], ['other', '[Mensaje no compatible]'], ['other', '[Mensaje no compatible]'],
    ]);
  });
  it('las reacciones no son mensajes; los mensajes sin id, sin remitente válido o sin texto se descartan', () => {
    const r = parseWebhook(wrap({ messages: [
      msg({ id: 'r', type: 'reaction', reaction: { message_id: 'x', emoji: '👍' } }),
      { from: '573101112233', timestamp: '1', type: 'text', text: { body: 'sin id' } },
      msg({ id: 'x1', from: 'abc', type: 'text', text: { body: 'remitente raro' } }),
      msg({ id: 'x2', from: '123', type: 'text', text: { body: 'demasiado corto' } }),
      msg({ id: 'x3', type: 'text', text: { body: '   ' } }),
      msg({ id: 'x4', type: 'text' }),
      msg({ id: 'ok', type: 'text', text: { body: 'bien' } }),
    ] }));
    expect(r.messages.map((m) => m.externalId)).toEqual(['ok']);
  });
  it('quita caracteres de control y respeta el largo máximo', () => {
    const r = parseWebhook(wrap({ messages: [msg({ type: 'text', text: { body: 'hola\u0000\u0007 mundo' } })] }));
    expect(r.messages[0]!.body).toBe('hola mundo');
    const big = parseWebhook(wrap({ messages: [msg({ type: 'text', text: { body: 'x'.repeat(10_000) } })] }));
    expect(big.messages[0]!.body.length).toBe(4096);
  });
  it('una hora inválida usa «ahora» en vez de fallar', () => {
    const r = parseWebhook(wrap({ messages: [msg({ timestamp: 'nunca', type: 'text', text: { body: 'x' } })] }));
    expect(Math.abs(new Date(r.messages[0]!.occurredAt).getTime() - Date.now())).toBeLessThan(5000);
  });
  it('limita el trabajo por payload (no procesa más de 500 mensajes)', () => {
    const many = Array.from({ length: 800 }, (_, i) => msg({ id: `w${i}`, type: 'text', text: { body: 'x' } }));
    expect(parseWebhook(wrap({ messages: many })).messages).toHaveLength(500);
  });
});

describe('lectura de estados', () => {
  it('enviado, entregado, leído y fallido (con su error traducido)', () => {
    const r = parseWebhook(wrap({ statuses: [
      { id: 'o1', status: 'sent', timestamp: '1758300001', recipient_id: '573101112233' },
      { id: 'o1', status: 'delivered', timestamp: '1758300002' },
      { id: 'o1', status: 'read', timestamp: '1758300003' },
      { id: 'o2', status: 'failed', timestamp: '1758300004', errors: [{ code: 131047, title: 'Re-engagement message' }] },
    ] }));
    expect(r.messages).toEqual([]);
    expect(r.statuses.map((s) => [s.externalId, s.status])).toEqual([['o1', 'sent'], ['o1', 'delivered'], ['o1', 'read'], ['o2', 'failed']]);
    expect(r.statuses[3]).toMatchObject({ errorCode: '131047' });
    expect(r.statuses[3]!.error).toMatch(/24 horas/);
  });
  it('descarta estados desconocidos o sin id', () => {
    const r = parseWebhook(wrap({ statuses: [{ id: 'o', status: 'deleted' }, { status: 'sent' }, { id: 'o3', status: 'sent' }] }));
    expect(r.statuses.map((s) => s.externalId)).toEqual(['o3']);
  });
});

describe('robustez ante payloads ajenos o malformados', () => {
  it('ignora otros objetos, otros campos y canales sin phone_number_id', () => {
    expect(parseWebhook({ object: 'instagram', entry: [] })).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook(wrap({ messages: [msg({ type: 'text', text: { body: 'x' } })] }, 'message_template_status_update'))).toEqual({ messages: [], statuses: [] });
    const noPid = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: {}, messages: [msg({ type: 'text', text: { body: 'x' } })] } }] }] };
    expect(parseWebhook(noPid).messages).toEqual([]);
    const badPid = wrap({ messages: [msg({ type: 'text', text: { body: 'x' } })] }); (badPid.entry[0]!.changes[0]!.value as { metadata: { phone_number_id: string } }).metadata.phone_number_id = "1; drop table";
    expect(parseWebhook(badPid).messages).toEqual([]);
  });
  it('no lanza con basura: null, números, texto, listas y estructuras profundas', () => {
    for (const junk of [null, undefined, 42, 'x', true, [], {}, { object: 'whatsapp_business_account' }, { object: 'whatsapp_business_account', entry: 'x' },
      { object: 'whatsapp_business_account', entry: [null, 1, 'a', { changes: 'x' }, { changes: [null, { field: 'messages', value: null }] }] }]) {
      expect(() => parseWebhook(junk)).not.toThrow();
      expect(parseWebhook(junk)).toEqual({ messages: [], statuses: [] });
    }
  });
  it('fuzz determinista: 500 estructuras aleatorias nunca lanzan y siempre devuelven mensajes válidos', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
    const val = (d: number): unknown => {
      const k = rnd();
      if (d > 4 || k < 0.25) return pick([null, 1, -5, 1e30, 'x', '', '573101112233', 'wamid.Z', true, 'messages', 'text', 'sent']);
      if (k < 0.5) return Array.from({ length: Math.floor(rnd() * 4) }, () => val(d + 1));
      const o: Record<string, unknown> = {};
      for (const key of ['object', 'entry', 'changes', 'field', 'value', 'metadata', 'phone_number_id', 'messages', 'statuses', 'contacts', 'profile', 'name', 'wa_id',
        'from', 'id', 'timestamp', 'type', 'text', 'body', 'image', 'caption', 'status', 'errors', 'code', 'title']) if (rnd() < 0.3) o[key] = val(d + 1);
      return o;
    };
    for (let i = 0; i < 500; i++) {
      const p = val(0);
      const r = parseWebhook(p);
      for (const m of r.messages) {
        expect(m.thread).toMatch(/^\d{6,20}$/);
        expect(m.phoneNumberId).toMatch(/^\d{5,30}$/);
        expect(m.externalId.length).toBeGreaterThan(0);
        expect(m.body.length).toBeGreaterThan(0);
        expect(Number.isNaN(new Date(m.occurredAt).getTime())).toBe(false);
      }
    }
  });
});

describe('errores de envío y cuerpos', () => {
  it('traduce los códigos conocidos y usa el texto de Meta como respaldo', () => {
    expect(describeSendError(131047)).toMatch(/plantilla aprobada/);
    expect(describeSendError('131047')).toMatch(/plantilla aprobada/);
    expect(describeSendError(190)).toMatch(/token/);
    expect(describeSendError(999999, 'Algo raro')).toBe('WhatsApp rechazó el mensaje: Algo raro');
    expect(describeSendError(undefined)).toBe('WhatsApp rechazó el mensaje.');
  });
  it('arma el cuerpo de texto y de plantilla como los exige la API', () => {
    expect(buildTextPayload('573001112233', 'Hola')).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001112233', type: 'text', text: { preview_url: false, body: 'Hola' } });
    expect(buildTemplatePayload('573001112233', 'seguimiento', 'es', ['Carlos', 'A-100'])).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001112233', type: 'template',
      template: { name: 'seguimiento', language: { code: 'es' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Carlos' }, { type: 'text', text: 'A-100' }] }] },
    });
    expect((buildTemplatePayload('57300', 'saludo', 'es', []).template as Record<string, unknown>).components).toBeUndefined();
  });
});
