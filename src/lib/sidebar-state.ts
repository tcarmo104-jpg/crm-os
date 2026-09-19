export const SIDEBAR_COOKIE = 'crm_sidebar';

export interface SidebarState {
  collapsed: boolean;
  /** Claves de grupos plegados. */
  closed: string[];
}

export const DEFAULT_SIDEBAR: SidebarState = { collapsed: false, closed: [] };

export function parseSidebarState(raw: string | undefined): SidebarState {
  if (!raw) return DEFAULT_SIDEBAR;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Partial<SidebarState>;
    return {
      collapsed: v.collapsed === true,
      closed: Array.isArray(v.closed) ? v.closed.filter((x): x is string => typeof x === 'string').slice(0, 20) : [],
    };
  } catch {
    return DEFAULT_SIDEBAR;
  }
}

export function serializeSidebarState(s: SidebarState): string {
  return encodeURIComponent(JSON.stringify(s));
}
