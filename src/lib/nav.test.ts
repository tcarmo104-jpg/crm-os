import { describe, expect, it } from 'vitest';
import { HOME, NAV_GROUPS, locate } from './nav';

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
  it('lo construido va agrupado por lo que hace la persona; lo que aún no existe queda aparte, plegable y solo con fase', () => {
    const soon = NAV_GROUPS.find((g) => g.key === 'soon')!;
    expect(soon.items.every((i) => !i.href && i.phase)).toBe(true);
    for (const g of NAV_GROUPS.filter((x) => x.key !== 'soon')) expect(g.items.every((i) => i.href), g.key).toBe(true);
    expect(NAV_GROUPS.map((g) => g.key)).toEqual(['main', 'commercial', 'settings', 'soon']);
  });
  it('las migas de pan ubican cualquier ruta en su grupo y módulo (el más específico gana)', () => {
    expect(locate('/inbox')).toMatchObject({ group: { label: 'Principal' }, item: { label: 'Inbox' } });
    expect(locate('/customers/123')).toMatchObject({ group: { label: 'Comercial' }, item: { label: 'Clientes' } });
    expect(locate('/settings/connections/whatsapp/x')).toMatchObject({ group: { label: 'Configuración' }, item: { label: 'Conexiones' } });
    expect(locate('/')).toMatchObject({ group: null, item: { label: 'Hoy' } });
    expect(locate('/ruta-que-no-existe')).toEqual({ group: null, item: null });
  });
});
