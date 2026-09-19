import { describe, expect, it } from 'vitest';
import { isAuthorizedCron } from './auth-secret';

const SECRET = 'a-very-long-random-secret-1234567890';

describe('isAuthorizedCron', () => {
  it('acepta el secreto correcto', () => {
    expect(isAuthorizedCron(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });
  it('rechaza secreto incorrecto, ausente o de distinta longitud', () => {
    expect(isAuthorizedCron('Bearer otro', SECRET)).toBe(false);
    expect(isAuthorizedCron(null, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedCron(SECRET, SECRET)).toBe(false);
  });
  it('rechaza si el secreto no está configurado o es demasiado corto', () => {
    expect(isAuthorizedCron('Bearer ', undefined)).toBe(false);
    expect(isAuthorizedCron('Bearer corto', 'corto')).toBe(false);
  });
});
