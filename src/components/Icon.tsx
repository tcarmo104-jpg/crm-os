import type { IconName } from '@/lib/nav';
import { SHAPES, STROKE } from './icon-shapes';

// Trazos simples en cuadrícula 24×24. Varias rutas se separan con "|".
export const SHELL_PATHS: Record<IconName, string> = {
  home: 'M3 11l9-8 9 8|M5 10v10h5v-6h4v6h5V10',
  users: 'M16 19v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1|M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6|M20 19v-1a3 3 0 0 0-2-2.8|M16 5.2a3 3 0 0 1 0 5.6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8|M4 21a8 8 0 0 1 16 0',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18|M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  file: 'M7 3h7l5 5v13H7z|M14 3v5h5|M10 13h6|M10 17h6',
  cash: 'M3 7h18v10H3z|M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  inbox: 'M3 13l3-8h12l3 8v6H3z|M3 13h5l1 2h6l1-2h5',
  chat: 'M4 5h16v11H9l-5 4z',
  mail: 'M3 6h18v12H3z|M3 7l9 7 9-7',
  check: 'M4 12l5 5L20 6',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  repeat: 'M17 2l3 3-3 3|M20 5H8a4 4 0 0 0-4 4v1|M7 22l-3-3 3-3|M4 19h12a4 4 0 0 0 4-4v-1',
  sparkle: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  chart: 'M4 20V4|M4 20h16|M8 16v-5|M12 16V8|M16 16v-3',
  funnel: 'M3 4h18l-7 8v6l-4 2v-8z',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4z|M3 7l9 4 9-4|M12 11v10',
  tool: 'M14 6a4 4 0 0 0 5 5l-9 9a2 2 0 0 1-3-3l9-9a4 4 0 0 0-2-2z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  plug: 'M9 3v5|M15 3v5|M6 8h12v3a6 6 0 0 1-12 0z|M12 17v4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6|M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2',
  team: 'M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6|M5 20a7 7 0 0 1 14 0|M4 9a2.5 2.5 0 1 0 0-5|M20 9a2.5 2.5 0 1 0 0-5',
  chevron: 'M9 6l6 6-6 6',
  sidebar: 'M3 5h18v14H3z|M9 5v14',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8|M12 2v2|M12 20v2|M2 12h2|M20 12h2|M4.9 4.9l1.4 1.4|M17.7 17.7l1.4 1.4|M4.9 19.1l1.4-1.4|M17.7 6.3l1.4-1.4',
  moon: 'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z',
  logout: 'M9 4H5v16h4|M16 8l4 4-4 4|M20 12H9',
  plus: 'M12 5v14|M5 12h14',
  copy: 'M9 9h11v11H9z|M5 15V4h11',
  menu: 'M4 6h16|M4 12h16|M4 18h16',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14|M20 20l-4-4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18|M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6|M12 17v.01',
  pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z|M12 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6',
  x: 'm6 6 12 12M18 6 6 18',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z',
  'eye-off': 'M3 3l18 18',
};

/** Un solo componente de iconos. Si el nombre está en `SHAPES` se dibuja esa forma; si no, la del menú. Nombre desconocido: no dibuja nada. */
export function Icon({ name, size = 18 }: { name: IconName | (string & {}); size?: number }) {
  const shape = SHAPES[name];
  const path = (SHELL_PATHS as Record<string, string | undefined>)[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shape ?? path?.split('|').map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
