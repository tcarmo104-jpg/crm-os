import type { ChannelKind } from '@/lib/inbox-view';
import { ChannelBadge } from './icons';

/** Iniciales sobre un color estable (el mismo nombre siempre da el mismo color), con la insignia del canal opcional. */
export function InboxAvatar({ name, channel, size = 40 }: { name: string; channel?: ChannelKind; size?: number }) {
  const clean = (name || '?').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '')).toUpperCase();
  let h = 0;
  for (const ch of clean) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="ib-avatar" style={{ width: size, height: size, fontSize: size * 0.36, ['--h' as string]: h }} aria-hidden="true">
      {initials}
      {channel ? <span className="ib-avatar-chan"><ChannelBadge kind={channel} size={Math.max(14, Math.round(size * 0.4))} /></span> : null}
    </span>
  );
}
