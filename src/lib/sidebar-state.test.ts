import { describe, expect, it } from 'vitest';
import { DEFAULT_SIDEBAR, parseSidebarState, serializeSidebarState } from './sidebar-state';

describe('estado del sidebar (cookie)', () => {
  it('ida y vuelta', () => {
    const s = { collapsed: true, closed: ['crm', 'comms'] };
    expect(parseSidebarState(serializeSidebarState(s))).toEqual(s);
  });
  it('ignora valores corruptos o maliciosos', () => {
    expect(parseSidebarState(undefined)).toEqual(DEFAULT_SIDEBAR);
    expect(parseSidebarState('%7Bnot-json')).toEqual(DEFAULT_SIDEBAR);
    expect(parseSidebarState(encodeURIComponent('{"collapsed":"yes","closed":[1,"a",null]}')))
      .toEqual({ collapsed: false, closed: ['a'] });
  });
});
