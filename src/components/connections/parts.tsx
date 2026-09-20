import type { ReactNode } from 'react';
import { stateInfo, type ProviderKey } from '@/lib/connections';

/** Logotipos sencillos (formas propias, no los oficiales) con el color de cada marca. */
export function Logo({ provider, size = 44 }: { provider: ProviderKey; size?: number }) {
  const s = { width: size, height: size } as const;
  const common = { viewBox: '0 0 44 44', role: 'img' as const, ...s };
  if (provider === 'whatsapp') return (
    <svg {...common} aria-label="WhatsApp"><rect width="44" height="44" rx="12" fill="#25d366" />
      <path d="M22 10.5a11.5 11.5 0 0 0-9.9 17.3L10.5 33.5l5.9-1.5A11.5 11.5 0 1 0 22 10.5Z" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M18 17.5c-.5 1.5.4 3.6 2.4 5.6 2 2 4.2 3 5.7 2.5l1.1-1.4-2.5-1.5-1 .9c-.9-.4-2-1.4-2.6-2.5l.8-1-1.3-2.6Z" fill="#fff" /></svg>
  );
  if (provider === 'instagram') return (
    <svg {...common} aria-label="Instagram"><defs><linearGradient id="ig" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#feda75" /><stop offset=".45" stopColor="#d62976" /><stop offset="1" stopColor="#4f5bd5" /></linearGradient></defs>
      <rect width="44" height="44" rx="12" fill="url(#ig)" /><rect x="12" y="12" width="20" height="20" rx="6" fill="none" stroke="#fff" strokeWidth="2.4" /><circle cx="22" cy="22" r="4.6" fill="none" stroke="#fff" strokeWidth="2.4" /><circle cx="28" cy="16" r="1.4" fill="#fff" /></svg>
  );
  if (provider === 'facebook') return (
    <svg {...common} aria-label="Facebook"><rect width="44" height="44" rx="12" fill="#0084ff" /><path d="M23.5 34V23h3.6l.6-4.2h-4.2v-2.5c0-1.2.4-2 2.1-2h2.2V10.6c-.4 0-1.7-.2-3.2-.2-3.2 0-5.3 1.9-5.3 5.4v3H15V23h3.3v11h5.2Z" fill="#fff" /></svg>
  );
  return (
    <svg {...common} aria-label="Gmail"><rect width="44" height="44" rx="12" fill="#fff" stroke="#e2e6f1" /><path d="M10 15.5 22 25l12-9.5V30a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 10 30V15.5Z" fill="#f2f2f2" /><path d="m10 15.5 12 9.5 12-9.5V14a2 2 0 0 0-3.2-1.6L22 19.2l-8.8-6.8A2 2 0 0 0 10 14v1.5Z" fill="#ea4335" /><path d="M10 14v16a1.5 1.5 0 0 0 1.5 1.5H14V19.6L10 16.5V14Zm24 0v16a1.5 1.5 0 0 1-1.5 1.5H30V19.6l4-3.1V14Z" fill="#4285f4" /></svg>
  );
}

export function StatusPill({ state }: { state: string }) {
  const i = stateInfo(state);
  return <span className={`cx-pill cx-pill--${i.tone}`}><i aria-hidden="true" />{i.label}</span>;
}

/** «Esta conexión alimenta el Inbox»: el indicador visual pedido, con estado real. */
export function InboxFeed({ live, label }: { live: boolean; label?: string }) {
  return (
    <span className={`cx-feed${live ? ' is-live' : ''}`} title={live ? 'Los mensajes de esta conexión llegan al Inbox del CRM' : 'Esta conexión no está alimentando el Inbox'}>
      <span className="cx-feed-dot" aria-hidden="true" />
      {label ?? (live ? 'Alimenta el Inbox' : 'No alimenta el Inbox')}
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9m-3.5-4L12 8l-3.5 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
}

export function KV({ children }: { children: ReactNode }) { return <dl className="cx-kv">{children}</dl>; }
export function Row({ k, children }: { k: string; children: ReactNode }) { return <><dt>{k}</dt><dd>{children}</dd></>; }
