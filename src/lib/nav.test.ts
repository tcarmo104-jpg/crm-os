import { describe, expect, it } from 'vitest';
import { HOME, NAV_GROUPS } from './nav';

const all = [HOME, ...NAV_GROUPS.flatMap((g) => g.items)];

describe('navegación', () => {
  it('las claves son únicas', () => {
    const keys = all.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('cada módulo está disponible (href) o declara la fase en que se habilita, nunca ambos ni ninguno', () => {
    for (const i of all) {
      expect(Boolean(i.href) !== Boolean(i.phase), `${i.key}`).toBe(true);
    }
  });
  it('los href son únicos y son rutas internas', () => {
    const hrefs = all.filter((i) => i.href).map((i) => i.href!);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const h of hrefs) expect(h.startsWith('/')).toBe(true);
  });
  it('las fases están dentro del plan (1–13)', () => {
    for (const i of all) if (i.phase) expect(i.phase).toBeGreaterThanOrEqual(2), expect(i.phase).toBeLessThanOrEqual(13);
  });
});
