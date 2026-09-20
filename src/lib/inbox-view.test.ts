import { describe, expect, it } from 'vitest';
import { EMPTY_QUERY, activeAdvancedFilters, dateFrom, inboxHref, parseInboxQuery, safeSearchText } from './inbox-view';

const ID = '11111111-1111-4111-8111-111111111111';

describe('estado del Inbox en la URL', () => {
  it('valores por defecto ante una URL vacía', () => {
    expect(parseInboxQuery({})).toEqual(EMPTY_QUERY);
  });
  it('lee cada filtro válido', () => {
    const q = parseInboxQuery({ f: 'unread', q: '  ana   ruiz ', canal: 'whatsapp', asesor: ID, etiqueta: ID, fecha: '7d', estado: 'closed', c: ID });
    expect(q).toEqual({ tab: 'unread', q: 'ana ruiz', canal: 'whatsapp', asesor: ID, etiqueta: ID, fecha: '7d', estado: 'closed', c: ID });
    expect(parseInboxQuery({ asesor: 'none' }).asesor).toBe('none');
  });
  it('descarta todo lo inválido o malicioso (nada llega a la base de datos sin validar)', () => {
    const q = parseInboxQuery({ f: 'hack', canal: 'telegram', asesor: "1; drop table x", etiqueta: 'no-uuid', fecha: '999d', estado: 'x', c: '../etc' });
    expect(q).toEqual(EMPTY_QUERY);
    expect(parseInboxQuery({ f: ['closed', 'unread'] }).tab).toBe('closed');       // parámetro repetido: primero
    expect(parseInboxQuery({ q: 'x'.repeat(500) }).q).toHaveLength(80);
  });
  it('arma enlaces omitiendo lo que es valor por defecto y respetando el resto', () => {
    expect(inboxHref(EMPTY_QUERY)).toBe('/inbox');
    expect(inboxHref(EMPTY_QUERY, { c: ID })).toBe(`/inbox?c=${ID}`);
    const base = parseInboxQuery({ f: 'mine', q: 'ana', canal: 'whatsapp' });
    expect(inboxHref(base, { c: ID })).toBe(`/inbox?f=mine&q=ana&canal=whatsapp&c=${ID}`);
    expect(inboxHref(base, { tab: 'all', q: '', canal: '' })).toBe('/inbox');
    expect(inboxHref({ ...EMPTY_QUERY, q: 'a&b=c' })).toBe('/inbox?q=a%26b%3Dc');   // se codifica: no rompe la URL
  });
  it('ida y vuelta: parsear lo que se construyó devuelve lo mismo', () => {
    const q = parseInboxQuery({ f: 'pending', q: 'sillas', asesor: 'none', fecha: 'hoy', c: ID });
    const href = inboxHref(q);
    expect(parseInboxQuery(Object.fromEntries(new URL(href, 'https://x.test').searchParams))).toEqual(q);
  });
  it('cuenta los filtros avanzados activos', () => {
    expect(activeAdvancedFilters(EMPTY_QUERY)).toBe(0);
    expect(activeAdvancedFilters({ ...EMPTY_QUERY, canal: 'whatsapp', fecha: 'hoy', tab: 'closed' })).toBe(2);
  });
  it('calcula el inicio del rango de fechas', () => {
    const now = new Date('2026-09-19T15:30:00');
    expect(dateFrom('', now)).toBeNull();
    expect(new Date(dateFrom('hoy', now)!).getHours()).toBe(0);
    expect(new Date(now).getTime() - new Date(dateFrom('7d', now)!).getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(new Date(now).getTime() - new Date(dateFrom('30d', now)!).getTime()).toBe(30 * 24 * 3600 * 1000);
  });
  it('el texto de búsqueda no puede inyectar comodines ni separadores del filtro', () => {
    expect(safeSearchText('ana,ruiz)or(id.eq.1')).toBe('ana ruiz or id.eq.1');
    expect(safeSearchText('50%_off *"\'')).toBe('50 off');
    expect(safeSearchText('   ')).toBe('');
  });
});
