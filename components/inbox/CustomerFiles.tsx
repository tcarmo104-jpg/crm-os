'use client';

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CHANNEL_LABEL } from '@/lib/inbox-view';
import { FILE_GROUPS, extOf, fileGroup, formatBytes, type FileGroup } from '@/lib/media';
import type { AttachmentRow } from '@/lib/types';
import { Ico } from './icons';
import { Lightbox } from './MessageMedia';

const src = (id: string, download = false) => `/api/media/${id}${download ? '?download=1' : ''}`;
const KIND_ICON: Record<string, string> = { video: 'video', audio: 'audio', image: 'image', sticker: 'image' };
const canView = (a: AttachmentRow) => a.mimeType === 'application/pdf' || a.mimeType === 'text/plain';

/**
 * Todos los archivos de UN cliente, de todas sus conversaciones y canales (WhatsApp, Instagram, Messenger, Gmail), lo más reciente primero.
 * Imágenes en cuadrícula con vista ampliada; el resto como filas con «Ver» / «Descargar». Cada archivo dice de qué conversación viene.
 */
export function CustomerFiles({ items, currentConversationId, timeZone, limit }: { items: AttachmentRow[]; currentConversationId: string; timeZone: string; limit: number }) {
  const [tab, setTab] = useState<'all' | FileGroup>('all');
  const [open, setOpen] = useState<number | null>(null);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const date = useMemo(() => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: '2-digit', timeZone }), [timeZone]);
  const counts = useMemo(() => {
    const c: Record<FileGroup, number> = { images: 0, docs: 0, av: 0 };
    for (const a of items) c[fileGroup(a.kind)]++;
    return c;
  }, [items]);

  if (items.length === 0) return <p className="ib-muted">Aún no hay archivos de este cliente. Los que envíe o le envíes por cualquier canal aparecerán aquí.</p>;

  const shown = tab === 'all' ? items : items.filter((a) => fileGroup(a.kind) === tab);
  const thumbs = shown.filter((a) => fileGroup(a.kind) === 'images' && !broken.has(a.id));
  const rows = shown.filter((a) => !thumbs.includes(a));
  const label = (a: AttachmentRow) => [
    extOf(a.fileName).toUpperCase() || null, formatBytes(a.fileSize) || null, a.createdAt ? date.format(new Date(a.createdAt)) : null,
    a.channel ? CHANNEL_LABEL[a.channel] : null, a.direction === 'outbound' ? 'enviado' : 'recibido',
  ].filter(Boolean).join(' · ');

  return (
    <div className="ib-files">
      <div className="ib-files-tabs" role="tablist" aria-label="Tipo de archivo">
        <button type="button" role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'is-active' : ''} onClick={() => setTab('all')}>Todo <span>{items.length}</span></button>
        {FILE_GROUPS.filter((g) => counts[g.key] > 0).map((g) => (
          <button key={g.key} type="button" role="tab" aria-selected={tab === g.key} className={tab === g.key ? 'is-active' : ''} onClick={() => setTab(g.key)}>{g.label} <span>{counts[g.key]}</span></button>
        ))}
      </div>

      {thumbs.length > 0 ? (
        <ul className="ib-files-grid">
          {thumbs.map((a, i) => (
            <li key={a.id}>
              <button type="button" className="ib-files-thumb" onClick={() => setOpen(i)} title={`${a.fileName ?? 'Imagen'} · ${label(a)}`} aria-label={`Ver ${a.fileName ?? 'imagen'} ampliada`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src(a.id)} alt={a.fileName ?? 'Imagen'} loading="lazy" onError={() => setBroken((s) => new Set(s).add(a.id))} ref={(el) => { if (el && el.complete && el.naturalWidth === 0) setBroken((s) => (s.has(a.id) ? s : new Set(s).add(a.id))); }} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {rows.length > 0 ? (
        <ul className="ib-files-list">
          {rows.map((a) => (
            <li key={a.id}>
              <span className="ib-media-ico"><Ico name={KIND_ICON[a.kind] ?? 'file'} size={18} /></span>
              <span className="ib-files-text">
                <strong title={a.fileName ?? undefined}>{a.fileName ?? 'Archivo'}</strong>
                <small>{label(a)}</small>
                <span className="ib-files-links">
                  {canView(a) ? <a href={src(a.id)} target="_blank" rel="noopener noreferrer">Ver</a> : null}
                  <a href={src(a.id, true)}>Descargar</a>
                  {a.conversationId && a.conversationId !== currentConversationId ? <a href={`/inbox?c=${a.conversationId}`}>Ir a su conversación</a> : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {items.length >= limit ? <p className="ib-muted ib-files-more">Se muestran los {limit} más recientes.</p> : null}
      {open !== null && thumbs[open] ? createPortal(<div className="ib ib-portal"><Lightbox images={thumbs} index={open} onClose={() => setOpen(null)} onIndex={setOpen} /></div>, document.body) : null}
    </div>
  );
}
