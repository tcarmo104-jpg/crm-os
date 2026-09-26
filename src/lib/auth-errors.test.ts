import { describe, expect, it } from 'vitest';
import { loginErrorMessage } from './auth-errors';

describe('loginErrorMessage: distingue credenciales incorrectas de un límite de intentos o una falla del servidor', () => {
  it('correo sin confirmar', () => {
    expect(loginErrorMessage({ status: 400, message: 'Email not confirmed' })).toMatch(/Confirma tu correo/);
  });
  it('demasiados intentos (protección que YA da Supabase): no se confunde con «credenciales incorrectas»', () => {
    expect(loginErrorMessage({ status: 429, message: 'Request rate limit reached' })).toBe('Hiciste demasiados intentos. Espera un minuto y vuelve a intentarlo.');
    expect(loginErrorMessage({ message: 'over rate limit' })).toMatch(/demasiados intentos/);
  });
  it('credenciales incorrectas: el mensaje exacto que pide el diseño, sin insinuar cuál de los dos campos falló', () => {
    const m = loginErrorMessage({ status: 400, message: 'Invalid login credentials' });
    expect(m).toBe('El correo electrónico o la contraseña no son correctos.');
    expect(m).not.toMatch(/correo no existe|no está registrado|contraseña incorrecta para/i);
  });
  it('cualquier otra falla (servidor caído, red, error inesperado): mensaje genérico, sin tecnicismos', () => {
    const m = loginErrorMessage({ status: 500, message: 'unexpected_failure: connection reset' });
    expect(m).toBe('No pudimos iniciar sesión. Inténtalo nuevamente.');
    expect(m).not.toMatch(/connection|reset|500|unexpected_failure/i);
  });
});
