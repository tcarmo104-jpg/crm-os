export type IconName =
  | 'home' | 'users' | 'user' | 'target' | 'file' | 'cash' | 'inbox' | 'chat' | 'mail' | 'check'
  | 'bolt' | 'repeat' | 'sparkle' | 'phone' | 'chart' | 'funnel' | 'box' | 'tool' | 'shield'
  | 'plug' | 'gear' | 'team' | 'chevron' | 'sidebar' | 'sun' | 'moon' | 'logout' | 'plus' | 'copy' | 'menu' | 'search' | 'help' | 'pin' | 'x' | 'eye' | 'eye-off';

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  /** Con href = disponible. Sin href = módulo aún no construido (se muestra deshabilitado). */
  href?: string;
  /** Fase del plan en la que se habilita (ver docs/ARCHITECTURE.md). */
  phase?: number;
}
export interface NavGroup { key: string; label: string; items: NavItem[] }

export const HOME: NavItem = { key: 'home', label: 'Hoy', icon: 'home', href: '/' };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'main', label: 'Principal',
    items: [
      { key: 'next-action', label: 'Mi próxima acción', icon: 'bolt', href: '/next-action' },
      { key: 'inbox', label: 'Inbox', icon: 'inbox', href: '/inbox' },
      { key: 'opportunities', label: 'Oportunidades', icon: 'target', href: '/opportunities' },
      { key: 'tasks', label: 'Tareas', icon: 'check', href: '/tasks' },
      { key: 'activities', label: 'Actividades', icon: 'pin', href: '/activities' },
    ],
  },
  {
    key: 'commercial', label: 'Comercial',
    items: [
      { key: 'customers', label: 'Clientes', icon: 'users', href: '/customers' },
      { key: 'leads', label: 'Leads', icon: 'funnel', href: '/leads' },
      { key: 'quotes', label: 'Cotizaciones', icon: 'file', href: '/quotes' },
      { key: 'sales', label: 'Ventas', icon: 'cash', href: '/sales' },
      { key: 'products', label: 'Productos y servicios', icon: 'box', href: '/products' },
      { key: 'cases', label: 'Casos de postventa', icon: 'shield', href: '/cases' },
      { key: 'sequences', label: 'Secuencias', icon: 'repeat', href: '/sequences' },
    ],
  },
  {
    key: 'settings', label: 'Configuración',
    items: [
      { key: 'connections', label: 'Conexiones', icon: 'plug', href: '/settings/connections' },
      { key: 'integrations', label: 'Integraciones', icon: 'plug', href: '/settings/integrations' },
      { key: 'members', label: 'Miembros', icon: 'user', href: '/settings/members' },
      { key: 'teams', label: 'Equipos', icon: 'team', href: '/settings/teams' },
      { key: 'pipelines', label: 'Pipelines', icon: 'funnel', href: '/settings/pipelines' },
      { key: 'fields', label: 'Campos personalizados', icon: 'tool', href: '/settings/fields' },
      { key: 'duplicates', label: 'Duplicados', icon: 'copy', href: '/settings/duplicates' },
      { key: 'channels', label: 'Canales (WhatsApp)', icon: 'chat', href: '/settings/channels' },
    ],
  },
  {
    // Lo que todavía no existe no compite con lo que sí: queda recogido y plegado.
    key: 'soon', label: 'Próximamente',
    items: [
      { key: 'whatsapp', label: 'WhatsApp', icon: 'chat', phase: 5 },
      { key: 'instagram', label: 'Instagram', icon: 'chat', phase: 5 },
      { key: 'facebook', label: 'Facebook', icon: 'chat', phase: 5 },
      { key: 'email', label: 'Email', icon: 'mail', phase: 5 },
      { key: 'automations', label: 'Automatizaciones', icon: 'tool', phase: 8 },
      { key: 'ai-assistant', label: 'Asistente de IA', icon: 'sparkle', phase: 9 },
      { key: 'recommendations', label: 'Recomendaciones', icon: 'bolt', phase: 9 },
      { key: 'dashboard', label: 'Dashboard', icon: 'chart', phase: 10 },
      { key: 'reports', label: 'Reportes', icon: 'file', phase: 10 },
      { key: 'funnel', label: 'Embudo', icon: 'funnel', phase: 10 },
      { key: 'performance', label: 'Desempeño', icon: 'chart', phase: 10 },
      { key: 'calls', label: 'Análisis de llamadas', icon: 'phone', phase: 11 },
      { key: 'ai-analyst', label: 'Analista de negocio', icon: 'sparkle', phase: 12 },
      { key: 'roles', label: 'Roles y permisos', icon: 'shield', phase: 13 },
      { key: 'settings-general', label: 'Configuración general', icon: 'gear', phase: 13 },
    ],
  },
];

/** Grupo y módulo al que pertenece una ruta (para las migas de pan). */
export function locate(pathname: string): { group: NavGroup | null; item: NavItem | null } {
  const candidates = [HOME, ...NAV_GROUPS.flatMap((g) => g.items)].filter((i) => i.href);
  const item = candidates
    .filter((i) => (i.href === '/' ? pathname === '/' : pathname === i.href || pathname.startsWith(i.href + '/')))
    .sort((a, b) => b.href!.length - a.href!.length)[0] ?? null;
  return { item, group: item ? NAV_GROUPS.find((g) => g.items.includes(item)) ?? null : null };
}
