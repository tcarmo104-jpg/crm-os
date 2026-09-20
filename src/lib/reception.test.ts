import { describe, expect, it } from 'vitest';
import { diagnoseReception, emptyStats, statsFromRows, type MetaCheck, type ReceptionFacts, type Stats } from './reception';

const NOW = new Date('2026-09-20T15:00:00Z');
const mins = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const facts = (o: Partial<Omit<ReceptionFacts, 'stats'>> & { stats?: Partial<Stats> } = {}): ReceptionFacts => ({
  secretSet: true, verifyTokenSet: true, siteUrlOk: true, wabaSubscribed: true, channelLastWebhookAt: null, meta: null, ...o, stats: { ...emptyStats(), ...(o.stats ?? {}) },
});
const meta = (o: Partial<MetaCheck> = {}): MetaCheck => ({ appId: '3431407853702583', tokenValid: true, tokenExpiresAt: null, subscription: 'ok', callbackUrl: 'https://crm.test/api/webhooks/meta', expectedUrl: 'https://crm.test/api/webhooks/meta', ...o });
const run = (f: ReceptionFacts) => diagnoseReception(f, NOW);
const step = (r: ReturnType<typeof run>, key: string) => r.steps.find((s) => s.key === key)!;

describe('leer los contadores de la base de datos', () => {
  it('convierte las filas en contadores y trae ceros para lo que no ocurrió', () => {
    const s = statsFromRows([{ outcome: 'accepted', hits: '3', last_at: mins(2) }, { outcome: 'bad_signature', hits: 1, last_at: mins(5) }, { outcome: 'inventado', hits: 9, last_at: null }]);
    expect(s.accepted).toEqual({ hits: 3, lastAt: mins(2) }); expect(s.bad_signature.hits).toBe(1); expect(s.verify_ok).toEqual({ hits: 0, lastAt: null });
    expect(Object.keys(s)).toHaveLength(6);
  });
});

describe('el diagnóstico dice UNA cosa: lo primero que falla', () => {
  it('la aplicación de Meta no está conectada al CRM: lo dice y manda a «Tu aplicación de Meta» (nada de Vercel)', () => {
    for (const f of [facts({ secretSet: false }), facts({ verifyTokenSet: false }), facts({ secretSet: false, verifyTokenSet: false })]) {
      const r = run(f);
      expect(r.verdict).toMatchObject({ kind: 'action', canAutoConfigure: false, title: 'Falta conectar tu aplicación de Meta al CRM.' });
      expect(r.verdict.action).toMatch(/«Tu aplicación de Meta»/); expect(r.verdict.action).toMatch(/«Guardar y conectar»/);
      expect(step(r, 'vars').status).toBe('fail'); expect(r.verdict.title + r.verdict.action + step(r, 'vars').detail).not.toMatch(/Vercel|Redeploy|META_[A-Z_]+|variable/i);
    }
  });
  it('el CRM abierto desde una dirección local o sin https: explica que Meta solo acepta direcciones públicas', () => {
    const r = run(facts({ siteUrlOk: false }));
    expect(r.verdict.title).toBe('El CRM se abrió desde una dirección local o sin https.'); expect(r.verdict.action).toMatch(/dirección pública/);
    expect(step(r, 'vars')).toMatchObject({ status: 'fail' });
  });
  it('Meta SÍ llega pero la firma no coincide → «la clave secreta no coincide» (el caso que antes era invisible)', () => {
    const r = run(facts({ stats: { bad_signature: { hits: 4, lastAt: mins(3) } } }));
    expect(r.verdict.title).toMatch(/Meta SÍ está enviando mensajes, pero el CRM los rechaza/); expect(r.verdict.action).toMatch(/Tu aplicación de Meta/); expect(r.verdict.canAutoConfigure).toBe(false);
    expect(step(r, 'signature')).toMatchObject({ status: 'fail' }); expect(step(r, 'signature').detail).toMatch(/Meta SÍ está llegando \(4 avisos/);
  });
  it('si ya hubo avisos aceptados y el último rechazo es ANTIGUO, no se culpa a la clave', () => {
    const r = run(facts({ stats: { accepted: { hits: 5, lastAt: mins(1) }, bad_signature: { hits: 2, lastAt: mins(600) } }, channelLastWebhookAt: mins(1) }));
    expect(r.verdict.kind).toBe('ok'); expect(step(r, 'signature').status).toBe('ok');
  });
  it('pero si el rechazo es MÁS RECIENTE que el último aceptado, sí (la clave cambió)', () => {
    expect(run(facts({ stats: { accepted: { hits: 5, lastAt: mins(600) }, bad_signature: { hits: 2, lastAt: mins(1) } } })).verdict.title).toMatch(/clave secreta no coincide/);
  });
  it('Meta intentó verificar y el token no coincide → ofrece configurarlo automáticamente', () => {
    const r = run(facts({ stats: { verify_rejected: { hits: 2, lastAt: mins(10) } } }));
    expect(r.verdict.title).toBe('Meta intentó conectarse, pero el token de verificación no coincide.'); expect(r.verdict.canAutoConfigure).toBe(true);
    expect(step(r, 'verify').status).toBe('fail');
    expect(run(facts({ stats: { verify_rejected: { hits: 2, lastAt: mins(10) }, verify_ok: { hits: 1, lastAt: mins(5) } } })).verdict.title).not.toMatch(/token de verificación/);   // ya verificó bien después
  });
  it('Meta NUNCA ha contactado al CRM → «el webhook no está configurado», con configuración automática', () => {
    const r = run(facts());
    expect(r.verdict.title).toMatch(/Meta todavía no sabe a dónde enviar tus mensajes/); expect(r.verdict.canAutoConfigure).toBe(true);
    expect(step(r, 'verify').status).toBe('todo'); expect(step(r, 'meta').status).toBe('todo');
  });
  it('con la consulta completa a Meta: sin webhook, otra dirección, o sin el campo messages', () => {
    expect(run(facts({ meta: meta({ subscription: 'missing', callbackUrl: null }) })).verdict.title).toMatch(/no está configurado/);
    const wrong = run(facts({ meta: meta({ subscription: 'wrong_url', callbackUrl: 'https://otro.com/hook' }) }));
    expect(wrong.verdict.title).toBe('Meta está enviando los mensajes a otra dirección.'); expect(step(wrong, 'meta').detail).toMatch(/otro\.com/); expect(wrong.verdict.canAutoConfigure).toBe(true);
    expect(run(facts({ meta: meta({ subscription: 'no_messages' }) })).verdict.title).toMatch(/no está suscrito a «messages»/);
  });
  it('si Meta no pudo consultarse, se avisa sin culpar a nadie', () => {
    const r = run(facts({ meta: meta({ subscription: 'error', error: 'timeout' }), stats: { accepted: { hits: 1, lastAt: mins(1) } } }));
    expect(step(r, 'meta')).toMatchObject({ status: 'warn' }); expect(step(r, 'meta').detail).toMatch(/timeout/);
  });
  it('la cuenta de WhatsApp Business sin suscribir', () => {
    const r = run(facts({ wabaSubscribed: false, stats: { verify_ok: { hits: 1, lastAt: mins(9) } }, meta: meta() }));
    expect(r.verdict.title).toMatch(/no está suscrita a tu app/); expect(r.verdict.action).toMatch(/Verificar ahora/);
  });
  it('token temporal: vence pronto (aviso) o ya venció (acción)', () => {
    const soon = run(facts({ channelLastWebhookAt: mins(1), stats: { accepted: { hits: 1, lastAt: mins(1) }, verify_ok: { hits: 1, lastAt: mins(30) } }, meta: meta({ tokenExpiresAt: new Date(NOW.getTime() + 20 * 3600_000).toISOString() }) }));
    expect(step(soon, 'token')).toMatchObject({ status: 'warn' }); expect(step(soon, 'token').detail).toMatch(/Vence en 20 h: es un token TEMPORAL/);
    expect(soon.verdict.kind).toBe('ok'); expect(soon.verdict.action).toMatch(/temporal y vence pronto/);
    const dead = run(facts({ stats: { verify_ok: { hits: 1, lastAt: mins(30) } }, meta: meta({ tokenExpiresAt: mins(5) }) }));
    expect(dead.verdict.title).toMatch(/token de acceso venció/); expect(step(dead, 'token').status).toBe('fail');
    expect(run(facts({ stats: { verify_ok: { hits: 1, lastAt: mins(30) } }, meta: meta({ tokenValid: false }) })).verdict.title).toMatch(/token de acceso venció o no es válido/);
  });
  it('todo bien y llegan mensajes → «no necesitas hacer nada»', () => {
    const r = run(facts({ channelLastWebhookAt: mins(2), meta: meta(), stats: { verify_ok: { hits: 1, lastAt: mins(900) }, accepted: { hits: 12, lastAt: mins(2) } } }));
    expect(r.verdict).toMatchObject({ kind: 'ok', action: 'No necesitas hacer nada.' }); expect(r.steps.every((s) => s.status === 'ok')).toBe(true);
  });
  it('Meta firma bien pero aún no llega un mensaje de este número → indica la prueba correcta', () => {
    const r = run(facts({ stats: { verify_ok: { hits: 1, lastAt: mins(30) }, accepted: { hits: 2, lastAt: mins(20) } } }));
    expect(r.verdict.kind).toBe('unknown'); expect(r.verdict.action).toMatch(/RESPÓNDELO desde tu celular/); expect(step(r, 'messages').status).toBe('warn');
  });
  it('los textos hablan en español claro, sin jerga técnica', () => {
    const all = [run(facts()), run(facts({ secretSet: false })), run(facts({ siteUrlOk: false })), run(facts({ stats: { bad_signature: { hits: 1, lastAt: mins(1) } } })), run(facts({ stats: { verify_rejected: { hits: 1, lastAt: mins(1) } } }))];
    for (const r of all) { const txt = r.verdict.title + r.verdict.action + r.steps.map((s) => s.title + s.detail).join(' '); expect(txt).not.toMatch(/HMAC|sha256|hub\.|payload|undefined|null|NaN|Vercel|Redeploy|META_[A-Z_]+/i); }
  });
});
