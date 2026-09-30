'use client';

import { useState } from 'react';
import type { ChannelKind } from '@/lib/inbox-view';
import { ChannelBadge } from './icons';

/** Foto real del contacto si existe (Facebook e Instagram la dan; WhatsApp no expone ninguna por su API, así
 * que ese canal siempre usa iniciales). Si la imagen falla al cargar, cae a iniciales sin parpadeo. */
export function InboxAvatar({ name, channel, avatarUrl, size = 40 }: { name: string; channel?: ChannelKind; avatarUrl?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const clean = (name || '?').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '')).toUpperCase();
  let h = 0;
  for (const ch of clean) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const showPhoto = !!avatarUrl && !broken;
  return (
    <span className="ib-avatar" style={{ width: size, height: size, fontSize: size * 0.36, ['--h' as string]: h }} aria-hidden="true">
      {showPhoto
        ? <img src={avatarUrl!} alt="" className="ib-avatar-img" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : initials}
      {channel ? <span className="ib-avatar-chan"><ChannelBadge kind={channel} size={Math.max(14, Math.round(size * 0.4))} /></span> : null}
    </span>
  );
}
