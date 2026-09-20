import { describe, expect, it } from 'vitest';
import { CONNECTION_STATES, STATE_INFO, classifyMetaError, isCheckDue, redact, stateInfo, timeAgo, webhookUrl } from './connections';
import { SecretError, encryptionEnabled, openSecret, sealSecret } from './secrets';

describe('estados de la conexión', () => {
  it('los siete estados tienen etiqueta, tono y mensaje comprensible (sin jerga técnica)', () => {
    expect(CONNECTION_STATES).toHaveLength(7);
    for (const s of CONNECTION_STATES) {
      const i = STATE_INFO[s];
      expect(i.label.length).toBeGreaterThan(3);
      const m = i.message('WhatsApp');
      expect(m.length).toBeGreaterThan(20);
      expect(m).not.toMatch(/OAuth|HTTP|\b190\b|Graph|exception|stack|undefined/i);
    }
  });
  it('el mensaje de autorización es el pedido: «requiere autorización nuevamente»', () => {
    expect(STATE_INFO.needs_auth.message('WhatsApp')).toBe('La conexión con WhatsApp requiere autorización nuevamente. Revisa los permisos y guarda un token válido en «Configurar».');
    expect(STATE_INFO.token_expired.message('WhatsApp')).toMatch(/requiere autorización nuevamente/);
  });
  it('solo «conectado» y «desconectado» no piden acción; un estado desconocido se trata como error', () => {
    expect(CONNECTION_STATES.filter((s) => !STATE_INFO[s].needsAction).sort()).toEqual(['connected', 'disconnected']);
    expect(stateInfo('inventado').label).toBe('Error de conexión');
    expect(stateInfo(null).tone).toBe('danger');
  });
});

describe('clasificación de errores de Meta', () => {
  it('token vencido o inválido', () => {
    expect(classifyMetaError({ code: 190 })).toEqual({ state: 'token_expired', code: '190' });
    expect(classifyMetaError({ code: '190', subcode: 463 })).toEqual({ state: 'token_expired', code: '190' });
    expect(classifyMetaError({ code: 102 })).toEqual({ state: 'token_expired', code: '102' });
  });
  it('permisos / falta de acceso', () => {
    for (const c of [3, 10, 200, 210, 299]) expect(classifyMetaError({ code: c })?.state).toBe('needs_auth');
    expect(classifyMetaError({ code: 100, subcode: 33 })).toEqual({ state: 'needs_auth', code: '100' });
    expect(classifyMetaError({ httpStatus: 401 })?.state).toBe('needs_auth');
    expect(classifyMetaError({ httpStatus: 403, code: null })?.state).toBe('needs_auth');
  });
  it('cuenta restringida = error', () => {
    expect(classifyMetaError({ code: 368 })?.state).toBe('error');
    expect(classifyMetaError({ code: 130497 })?.state).toBe('error');
  });
  it('lo que NO dice nada de la salud de la conexión no la marca como caída', () => {
    for (const c of [4, 17, 32, 613, 80007, 131047, 131026, 100, 1, 2]) expect(classifyMetaError({ code: c })).toBeNull();
    expect(classifyMetaError({ httpStatus: 500 })).toBeNull();
    expect(classifyMetaError({})).toBeNull();
  });
});

describe('redacción de secretos', () => {
  it('elimina tokens de Meta, encabezados y parámetros', () => {
    const t = 'EAAGm0PX4ZCpsBOxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    expect(redact(`fallo con ${t} en la llamada`)).toBe('fallo con [token] en la llamada');
    expect(redact('Authorization: Bearer abc.def-123_xyz')).toBe('Authorization: Bearer [token]');
    expect(redact('GET /me?access_token=SECRETO123&fields=id')).toBe('GET /me?access_token=[token]&fields=id');
    expect(redact('client_secret=abcd1234&x=1')).toBe('client_secret=[token]&x=1');
    expect(redact('a'.repeat(60))).toBe('[token]');
    expect(redact('token EAAB1234567890abcdefgh falló')).toBe('token [token] falló');   // un token corto de Meta también (no llega a 40 caracteres)
  });
  it('respeta el límite y tolera vacíos', () => {
    expect(redact('palabra '.repeat(200))).toHaveLength(500);
    expect(redact(null)).toBe('');
    expect(redact('texto normal con 12345')).toBe('texto normal con 12345');
  });
});

describe('textos y plazos', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  it('tiempo transcurrido, determinista', () => {
    expect(timeAgo(null, now)).toBe('Nunca');
    expect(timeAgo('basura', now)).toBe('Nunca');
    expect(timeAgo('2026-09-20T11:59:40Z', now)).toBe('hace un momento');
    expect(timeAgo('2026-09-20T11:55:00Z', now)).toBe('hace 5 min');
    expect(timeAgo('2026-09-20T09:00:00Z', now)).toBe('hace 3 h');
    expect(timeAgo('2026-09-19T11:00:00Z', now)).toBe('hace 1 día');
    expect(timeAgo('2026-09-10T12:00:00Z', now)).toBe('hace 10 días');
    expect(timeAgo('2026-07-01T12:00:00Z', now)).toBe('01/07/2026');
  });
  it('dirección del webhook', () => {
    expect(webhookUrl('https://crm-os-steel.vercel.app/')).toBe('https://crm-os-steel.vercel.app/api/webhooks/meta');
    expect(webhookUrl('crm.ejemplo.com')).toBeNull();
    expect(webhookUrl(undefined)).toBeNull();
  });
  it('cuándo toca verificar: nunca verificada, o vencido el plazo (más corto si hay problema); nunca si está desconectada', () => {
    expect(isCheckDue({ connectionStatus: 'pending', lastCheckedAt: null }, now)).toBe(true);
    expect(isCheckDue({ connectionStatus: 'connected', lastCheckedAt: '2026-09-20T10:00:00Z' }, now)).toBe(false);
    expect(isCheckDue({ connectionStatus: 'connected', lastCheckedAt: '2026-09-20T05:00:00Z' }, now)).toBe(true);
    expect(isCheckDue({ connectionStatus: 'error', lastCheckedAt: '2026-09-20T11:15:00Z' }, now)).toBe(true);
    expect(isCheckDue({ connectionStatus: 'error', lastCheckedAt: '2026-09-20T11:45:00Z' }, now)).toBe(false);
    expect(isCheckDue({ connectionStatus: 'disconnected', lastCheckedAt: null }, now)).toBe(false);
  });
});

describe('cifrado de tokens', () => {
  const KEY = 'una-llave-larga-de-al-menos-32-caracteres-123';
  const env = (k?: string) => ({ CONNECTIONS_ENCRYPTION_KEY: k }) as unknown as NodeJS.ProcessEnv;
  it('sin llave no cifra (y lo avisa el estado), con llave sí; ida y vuelta exacta', () => {
    expect(encryptionEnabled(env())).toBe(false);
    expect(sealSecret('EAAB-token', env())).toBe('EAAB-token');
    expect(encryptionEnabled(env(KEY))).toBe(true);
    const s = sealSecret('EAAB-token-ñ-✓', env(KEY));
    expect(s.startsWith('enc:v1:')).toBe(true);
    expect(s).not.toContain('EAAB');
    expect(openSecret(s, env(KEY))).toBe('EAAB-token-ñ-✓');
  });
  it('cada cifrado es distinto (IV aleatorio)', () => {
    expect(sealSecret('x', env(KEY))).not.toBe(sealSecret('x', env(KEY)));
  });
  it('una llave corta se ignora (no da una falsa sensación de seguridad)', () => {
    expect(encryptionEnabled(env('corta'))).toBe(false);
    expect(sealSecret('EAAB', env('corta'))).toBe('EAAB');
  });
  it('un token antiguo sin cifrar se sigue leyendo', () => {
    expect(openSecret('EAAB-antiguo', env(KEY))).toBe('EAAB-antiguo');
    expect(openSecret('EAAB-antiguo', env())).toBe('EAAB-antiguo');
  });
  it('llave ausente, incorrecta o dato alterado: FALLA, nunca devuelve basura', () => {
    const s = sealSecret('EAAB-token', env(KEY));
    expect(() => openSecret(s, env())).toThrowError(SecretError);
    expect(() => openSecret(s, env('otra-llave-larga-de-al-menos-32-caracteres-999'))).toThrowError(SecretError);
    const parts = s.split(':'); parts[4] = parts[4]!.slice(0, -2) + 'AA';
    expect(() => openSecret(parts.join(':'), env(KEY))).toThrowError(SecretError);
    expect(() => openSecret('enc:v1:solo-dos:partes', env(KEY))).toThrowError(SecretError);
    try { openSecret(s, env()); } catch (e) { expect((e as SecretError).reason).toBe('key_missing'); }
  });
});
