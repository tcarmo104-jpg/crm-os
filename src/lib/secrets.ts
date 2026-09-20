/**
 * Cifrado de tokens en reposo (AES-256-GCM). Es OPCIONAL: se activa al definir CONNECTIONS_ENCRYPTION_KEY.
 * Formato: «enc:v1:<iv>:<etiqueta>:<cifrado>». Un texto sin ese prefijo se considera un token antiguo sin cifrar
 * (así los ya guardados siguen funcionando). Con la llave incorrecta o ausente, abrir un token cifrado FALLA:
 * nunca se devuelve basura como si fuera un token.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';
const AAD = Buffer.from('crm-os:channel-token');

export class SecretError extends Error {
  constructor(readonly reason: 'key_missing' | 'key_invalid' | 'corrupt') { super(`secret_${reason}`); }
}

function keyFrom(raw: string | undefined): Buffer | null {
  const k = (raw ?? '').trim();
  if (k.length < 32) return null;                       // una llave corta no protege: se ignora
  return createHash('sha256').update(k).digest();
}

export const encryptionEnabled = (env: NodeJS.ProcessEnv = process.env) => keyFrom(env.CONNECTIONS_ENCRYPTION_KEY) !== null;

export function sealSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = keyFrom(env.CONNECTIONS_ENCRYPTION_KEY);
  if (!key) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}

export function openSecret(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = keyFrom(env.CONNECTIONS_ENCRYPTION_KEY);
  if (!key) throw new SecretError('key_missing');
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new SecretError('corrupt');
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0]!, 'base64url'));
    d.setAAD(AAD);
    d.setAuthTag(Buffer.from(parts[1]!, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[2]!, 'base64url')), d.final()]).toString('utf8');
  } catch {
    throw new SecretError('key_invalid');
  }
}
