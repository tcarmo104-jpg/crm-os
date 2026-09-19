import { describe, expect, it } from 'vitest';
import { buildIngestPayload, leadInputSchema } from './ingest';

describe('leadInputSchema', () => {
  it('acepta un lead típico y recorta espacios', () => {
    const r = leadInputSchema.parse({ name: '  Ana  ', phone: '300 111 2233', source: 'instagram', consent: true });
    expect(r.name).toBe('Ana');
    expect(r.consent).toBe(true);
  });
  it('rechaza tipos y formatos inválidos', () => {
    expect(leadInputSchema.safeParse({ consent: 'yes' }).success).toBe(false);
    expect(leadInputSchema.safeParse({ country: 'COL' }).success).toBe(false);
    expect(leadInputSchema.safeParse({ type: 'robot' }).success).toBe(false);
    expect(leadInputSchema.safeParse({ notes: 'x'.repeat(2001) }).success).toBe(false);
    expect(leadInputSchema.safeParse({ custom_fields: { 'Clave Mala': 1 } }).success).toBe(false);
  });
  it('cadenas vacías se tratan como ausentes', () => {
    expect(leadInputSchema.parse({ name: '', email: '' })).toMatchObject({ name: undefined, email: undefined });
  });
});

describe('buildIngestPayload', () => {
  it('normaliza contacto y arma el payload para la BD', () => {
    const input = leadInputSchema.parse({
      name: 'Laura', phone: '310 111 2233', email: 'LAURA@X.com', city: 'Cali', country: 'co', source: 'web', campaign: 'verano',
    });
    const r = buildIngestPayload(input, 'CO', { original: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.identifiers).toEqual([
      { type: 'phone', value: '+573101112233' },
      { type: 'email', value: 'laura@x.com' },
    ]);
    expect(r.payload.attrs).toEqual({ city: 'Cali', country: 'CO' });
    expect(r.payload.source).toBe('web');
    expect(r.payload.raw).toEqual({ original: true });
    expect('ad' in r.payload).toBe(false);
  });
  it('sin ningún contacto válido no se acepta y explica por qué', () => {
    const none = buildIngestPayload(leadInputSchema.parse({ name: 'Sin datos' }), 'CO');
    expect(none).toMatchObject({ ok: false });
    const bad = buildIngestPayload(leadInputSchema.parse({ phone: '123' }), 'CO');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/Teléfono no válido/);
  });
  it('un dato inválido junto a uno válido se acepta con advertencia', () => {
    const r = buildIngestPayload(leadInputSchema.parse({ phone: '123', email: 'a@b.co' }), 'CO');
    expect(r.ok && r.warnings.length).toBe(1);
  });
  it('la fuente por defecto es "api"', () => {
    const r = buildIngestPayload(leadInputSchema.parse({ email: 'a@b.co' }), 'CO');
    expect(r.ok && r.payload.source).toBe('api');
  });
});
