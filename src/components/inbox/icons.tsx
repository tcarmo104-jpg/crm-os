import type { ReactNode } from 'react';
import { Icon } from '../Icon';
import type { ChannelKind } from '@/lib/inbox-view';


/** Mismo componente que `Icon` (un solo juego de iconos, un solo peso de trazo). */
export function Ico({ name, size = 18 }: { name: string; size?: number }) {
  return <Icon name={name} size={size} />;
}

/** Insignia del canal (círculo pequeño con su color). Solo WhatsApp tiene conversaciones reales hoy; los otros dos ya están preparados. */
export function ChannelBadge({ kind, size = 16 }: { kind: ChannelKind; size?: number }) {
  const glyph: Record<ChannelKind, ReactNode> = {
    whatsapp: <path d="M12 4.2a7.8 7.8 0 0 0-6.7 11.8L4.2 19.8l3.9-1a7.8 7.8 0 1 0 3.9-14.6zM9.2 8.9c.2-.4.4-.4.6-.4h.4c.2 0 .3.1.4.3l.6 1.4c0 .2 0 .3-.1.4l-.4.5c-.1.1-.1.3 0 .4a4.6 4.6 0 0 0 2 1.7c.2.1.3 0 .4-.1l.5-.6c.1-.1.3-.2.4-.1l1.4.7c.2.1.3.2.2.4-.1.7-.8 1.3-1.6 1.3-1.9-.2-4.6-2-5.1-4.2-.1-.5 0-1.1.3-1.5z" fill="currentColor" stroke="none" />,
    instagram: <><rect x="6.5" y="6.5" width="11" height="11" rx="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="15.4" cy="8.6" r=".9" fill="currentColor" stroke="none" /></>,
    gmail: <path d="M5 7.5 12 13l7-5.5M5.5 6.5h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />,
    facebook: <path d="M12 4.5c-4.1 0-7.3 3-7.3 6.9 0 2.1 1 4 2.6 5.2V20l2.6-1.4c.7.2 1.4.3 2.1.3 4.1 0 7.3-3 7.3-6.9S16.1 4.5 12 4.5zm.8 8.6-1.9-2-3.7 2 4.1-4.3 1.9 2 3.6-2z" fill="currentColor" stroke="none" />,
  };
  return (
    <span className={`ib-chan ib-chan--${kind}`} style={{ width: size, height: size }} title={kind === 'whatsapp' ? 'WhatsApp' : kind === 'instagram' ? 'Instagram' : kind === 'gmail' ? 'Gmail' : 'Messenger'}>
      <svg width={size * 0.72} height={size * 0.72} viewBox="0 0 24 24" aria-hidden="true">{glyph[kind]}</svg>
    </span>
  );
}
