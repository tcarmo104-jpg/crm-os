import { describe, expect, it } from 'vitest';
import { invitationSchema, organizationSchema, signupSchema, teamSchema } from './schemas';

describe('organizationSchema', () => {
  it('acepta datos válidos y normaliza el slug', () => {
    const r = organizationSchema.parse({ name: '  Acme SAS ', slug: 'ACME-co' });
    expect(r).toEqual({ name: 'Acme SAS', slug: 'acme-co' });
  });
  it('rechaza slugs inválidos', () => {
    for (const slug of ['a', '-acme', 'acme-', 'ac me', 'acmé', 'x'.repeat(41)]) {
      expect(organizationSchema.safeParse({ name: 'Acme', slug }).success).toBe(false);
    }
  });
});

describe('invitationSchema', () => {
  it('normaliza el email y trata el equipo vacío como ausente', () => {
    const r = invitationSchema.parse({ email: ' Ana@Acme.COM ', roleKey: 'sales_agent', teamId: '' });
    expect(r.email).toBe('ana@acme.com');
    expect(r.teamId).toBeUndefined();
  });
  it('NO permite invitar como super_admin ni roles desconocidos', () => {
    expect(invitationSchema.safeParse({ email: 'a@b.co', roleKey: 'super_admin' }).success).toBe(false);
    expect(invitationSchema.safeParse({ email: 'a@b.co', roleKey: 'root' }).success).toBe(false);
  });
  it('rechaza emails y equipos inválidos', () => {
    expect(invitationSchema.safeParse({ email: 'no-es-email', roleKey: 'viewer' }).success).toBe(false);
    expect(invitationSchema.safeParse({ email: 'a@b.co', roleKey: 'viewer', teamId: 'no-uuid' }).success).toBe(false);
  });
});

describe('teamSchema / signupSchema', () => {
  it('valida equipos', () => {
    expect(teamSchema.safeParse({ name: '' }).success).toBe(false);
    expect(teamSchema.parse({ name: ' Bogotá ', region: '' })).toEqual({ name: 'Bogotá', region: undefined });
  });
  it('exige contraseña de al menos 10 caracteres', () => {
    expect(signupSchema.safeParse({ fullName: 'Ana', email: 'a@b.co', password: '123456789' }).success).toBe(false);
    expect(signupSchema.safeParse({ fullName: 'Ana', email: 'a@b.co', password: '1234567890' }).success).toBe(true);
  });
});
