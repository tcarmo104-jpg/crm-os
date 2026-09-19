export type IconName =
  | 'home' | 'users' | 'user' | 'target' | 'file' | 'cash' | 'inbox' | 'chat' | 'mail' | 'check'
  | 'bolt' | 'repeat' | 'sparkle' | 'phone' | 'chart' | 'funnel' | 'box' | 'tool' | 'shield'
  | 'plug' | 'gear' | 'team' | 'chevron' | 'sidebar' | 'sun' | 'moon' | 'logout' | 'plus' | 'copy' | 'menu';

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
    key: 'crm', label: 'CRM',
    items: [
      { key: 'customers', label: 'Clientes', icon: 'users', href: '/customers' },
      { key: 'leads', label: 'Leads', icon: 'funnel', href: '/leads' },
      { key: 'opportunities', label: 'Oportunidades', icon: 'target', href: '/opportunities' },
      { key: 'quotes', label: 'Cotizaciones', icon: 'file', href: '/quotes' },
      { key: 'sales', label: 'Ventas', icon: 'cash', href: '/sales' },
      { key: 'cases', label: 'Casos de postventa', icon: 'shield', href: '/cases' },
    ],
  },
  {
    key: 'comms', label: 'Comunicaciones',
    items: [
      { key: 'inbox', label: 'Inbox', icon: 'inbox', href: '/inbox' },
      { key: 'whatsapp', label: 'WhatsApp', icon: 'chat', phase: 5 },
      { key: 'instagram', label: 'Instagram', icon: 'chat', phase: 5 },
      { key: 'facebook', label: 'Facebook', icon: 'chat', phase: 5 },
      { key: 'email', label: 'Email', icon: 'mail', phase: 5 },
    ],
  },
  {
    key: 'execution', label: 'Ejecución',
    items: [
      { key: 'next-action', label: 'Mi próxima acción', icon: 'bolt', phase: 7 },
      { key: 'tasks', label: 'Tareas', icon: 'check', href: '/tasks' },
      { key: 'sequences', label: 'Secuencias', icon: 'repeat', phase: 7 },
      { key: 'automations', label: 'Automatizaciones', icon: 'tool', phase: 8 },
    ],
  },
  {
    key: 'intelligence', label: 'Inteligencia',
    items: [
      { key: 'ai-assistant', label: 'Asistente de IA', icon: 'sparkle', phase: 9 },
      { key: 'ai-analyst', label: 'Analista de negocio', icon: 'sparkle', phase: 12 },
      { key: 'calls', label: 'Análisis de llamadas', icon: 'phone', phase: 11 },
      { key: 'recommendations', label: 'Recomendaciones', icon: 'bolt', phase: 9 },
    ],
  },
  {
    key: 'analytics', label: 'Analytics',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: 'chart', phase: 10 },
      { key: 'reports', label: 'Reportes', icon: 'file', phase: 10 },
      { key: 'funnel', label: 'Embudo', icon: 'funnel', phase: 10 },
      { key: 'performance', label: 'Desempeño', icon: 'chart', phase: 10 },
    ],
  },
  {
    key: 'catalog', label: 'Catálogo',
    items: [
      { key: 'products', label: 'Productos y servicios', icon: 'box', href: '/products' },
    ],
  },
  {
    key: 'admin', label: 'Administración',
    items: [
      { key: 'members', label: 'Miembros', icon: 'user', href: '/settings/members' },
      { key: 'teams', label: 'Equipos', icon: 'team', href: '/settings/teams' },
      { key: 'roles', label: 'Roles', icon: 'shield', phase: 13 },
      { key: 'pipelines', label: 'Pipelines', icon: 'funnel', href: '/settings/pipelines' },
      { key: 'duplicates', label: 'Duplicados', icon: 'copy', href: '/settings/duplicates' },
      { key: 'fields', label: 'Campos personalizados', icon: 'tool', href: '/settings/fields' },
      { key: 'channels', label: 'Canales (WhatsApp)', icon: 'chat', href: '/settings/channels' },
      { key: 'integrations', label: 'Integraciones', icon: 'plug', href: '/settings/integrations' },
      { key: 'settings', label: 'Configuración', icon: 'gear', phase: 13 },
    ],
  },
];
