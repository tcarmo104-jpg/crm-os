import type { ReactNode } from 'react';
import type { ChannelKind } from '@/lib/inbox-view';

const PATHS: Record<string, ReactNode> = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  filter: <path d="M4 5h16l-6 8v5l-4 2v-7z" />,
  paperclip: <path d="m20 11-8.2 8.2a5 5 0 0 1-7-7L13.5 3.5a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15 6.2" />,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 3.5 3L16 12l4 4.5" /></>,
  smile: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01" /></>,
  bolt: <path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z" />,
  send: <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  panel: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M15 4.5v15" /></>,
  phone: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z" />,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4 7 8 6 8-6" /></>,
  pin: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  building: <><path d="M5 21V5.5A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5V21M15 10h3.5A1.5 1.5 0 0 1 20 11.5V21M3 21h18M8.5 8h3M8.5 12h3M8.5 16h3" /></>,
  user: <><circle cx="12" cy="8.5" r="3.7" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  file: <><path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z" /><path d="M14 3.5V8h4" /></>,
  video: <><rect x="3.5" y="6.5" width="12" height="11" rx="2.5" /><path d="m15.5 11 5-2.8v7.6l-5-2.8" /></>,
  audio: <><path d="M4 14v-4M8 17V7M12 20V4M16 17V7M20 14v-4" /></>,
  note: <><path d="M6 3.5h12A1.5 1.5 0 0 1 19.5 5v10L14 20.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z" /><path d="M14 20.5V15h5.5M8 8.5h8M8 12h5" /></>,
  bot: <><rect x="4.5" y="8" width="15" height="11" rx="3" /><path d="M12 8V5M9.5 13h.01M14.5 13h.01M9.5 16.2h5" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  tag: <><path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7a1 1 0 0 1 .7.3l7.3 7.3a1 1 0 0 1 0 1.4l-7.4 7.4a1 1 0 0 1-1.4 0l-7.3-7.3a1 1 0 0 1-.3-.7z" /><circle cx="8" cy="8" r="1.3" /></>,
  inbox: <path d="M4 13.5 6 5.5h12l2 8m-16 0V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5m-16 0h4.5a3.5 3.5 0 0 0 7 0H20" />,
};

export function Ico({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name] ?? null}
    </svg>
  );
}

/** Insignia del canal (círculo pequeño con su color). Solo WhatsApp tiene conversaciones reales hoy; los otros dos ya están preparados. */
export function ChannelBadge({ kind, size = 16 }: { kind: ChannelKind; size?: number }) {
  const glyph: Record<ChannelKind, ReactNode> = {
    whatsapp: <path d="M12 4.2a7.8 7.8 0 0 0-6.7 11.8L4.2 19.8l3.9-1a7.8 7.8 0 1 0 3.9-14.6zM9.2 8.9c.2-.4.4-.4.6-.4h.4c.2 0 .3.1.4.3l.6 1.4c0 .2 0 .3-.1.4l-.4.5c-.1.1-.1.3 0 .4a4.6 4.6 0 0 0 2 1.7c.2.1.3 0 .4-.1l.5-.6c.1-.1.3-.2.4-.1l1.4.7c.2.1.3.2.2.4-.1.7-.8 1.3-1.6 1.3-1.9-.2-4.6-2-5.1-4.2-.1-.5 0-1.1.3-1.5z" fill="currentColor" stroke="none" />,
    instagram: <><rect x="6.5" y="6.5" width="11" height="11" rx="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="15.4" cy="8.6" r=".9" fill="currentColor" stroke="none" /></>,
    facebook: <path d="M12 4.5c-4.1 0-7.3 3-7.3 6.9 0 2.1 1 4 2.6 5.2V20l2.6-1.4c.7.2 1.4.3 2.1.3 4.1 0 7.3-3 7.3-6.9S16.1 4.5 12 4.5zm.8 8.6-1.9-2-3.7 2 4.1-4.3 1.9 2 3.6-2z" fill="currentColor" stroke="none" />,
  };
  return (
    <span className={`ib-chan ib-chan--${kind}`} style={{ width: size, height: size }} title={kind === 'whatsapp' ? 'WhatsApp' : kind === 'instagram' ? 'Instagram' : 'Messenger'}>
      <svg width={size * 0.72} height={size * 0.72} viewBox="0 0 24 24" aria-hidden="true">{glyph[kind]}</svg>
    </span>
  );
}
