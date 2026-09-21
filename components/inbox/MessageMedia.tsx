'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { extOf, formatBytes } from '@/lib/media';
import type { AttachmentRow } from '@/lib/types';
import { Ico } from './icons';

const src = (id: string, download = false) => `/api/media/${id}${download ? '?download=1' : ''}`;
const canView = (a: AttachmentRow) => a.mimeType === 'application/pdf' || a.mimeType === 'text/plain' || (a.mimeType ?? '').startsWith('image/');

const STATUS_TEXT: Record<string, { title: string; hint: string }> = {
  pending: { title: 'Descargando archivo…', hint: 'Aparecerá en unos segundos.' },
  downloading: { title: 'Descargando archivo…', hint: 'Aparecerá en unos segundos.' },
  failed: { title: 'No se pudo descargar el archivo', hint: 'Se reintentará automáticamente; si no llega, pídele al cliente que lo reenvíe.' },
  expired: { title: 'El archivo ya no está disponible', hint: 'Venció en el canal antes de poder guardarse. Pídele al cliente que lo reenvíe.' },
  blocked: { title: 'Archivo bloqueado por seguridad', hint: 'Su contenido no coincide con su tipo o puede ser peligroso. No se guardó.' },
  unsupported: { title: 'Contenido no compatible', hint: 'Este tipo de contenido no puede mostrarse en el Inbox.' },
};
const KIND_ICON: Record<string, string> = { image: 'image', sticker: 'image', video: 'video', audio: 'audio' };

function Card({ icon, title, hint, actions }: { icon: string; title: string; hint?: string; actions?: React.ReactNode }) {
  return (
    <div className="ib-att-card">
      <span className="ib-media-ico"><Ico name={icon} size={22} /></span>
      <span className="ib-media-text"><strong>{title}</strong>{hint ? <small>{hint}</small> : null}</span>
      {actions ? <span className="ib-att-actions">{actions}</span> : null}
    </div>
  );
}

/** Visor ampliado: se cierra con Esc, con el botón o tocando fuera; se puede descargar; la conversación queda intacta detrás. */
export function Lightbox({ images, index, onClose, onIndex }: { images: AttachmentRow[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const cur = images[index]!;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [index, images.length, onClose, onIndex]);
  return (
    <div className="ib-lb" role="dialog" aria-modal="true" aria-label={`Vista ampliada: ${cur.fileName ?? 'imagen'}`} onClick={onClose}>
      <div className="ib-lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="ib-lb-name">{cur.fileName ?? 'Imagen'}{cur.fileSize ? ` · ${formatBytes(cur.fileSize)}` : ''}{images.length > 1 ? ` · ${index + 1}/${images.length}` : ''}</span>
        <a className="ib-btn ib-btn--sm" href={src(cur.id, true)}>Descargar</a>
        <button ref={closeRef} type="button" className="ib-btn ib-btn--sm ib-btn--primary" onClick={onClose}>Cerrar</button>
      </div>
      <div className="ib-lb-stage">
        {index > 0 ? <button type="button" className="ib-lb-nav ib-lb-prev" aria-label="Anterior" onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }}>‹</button> : null}
        {/* Tocar la imagen NO cierra; tocar el fondo oscuro que la rodea SÍ. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src(cur.id)} alt={cur.fileName ?? 'Imagen'} onClick={(e) => e.stopPropagation()} />
        {index < images.length - 1 ? <button type="button" className="ib-lb-nav ib-lb-next" aria-label="Siguiente" onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }}>›</button> : null}
      </div>
    </div>
  );
}

/** Los adjuntos de UN mensaje, con la misma interpretación para cualquier canal (WhatsApp, Instagram, Messenger, Gmail). */
export function MessageMedia({ items }: { items: AttachmentRow[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const images = items.filter((a) => a.status === 'stored' && (a.kind === 'image' || a.kind === 'sticker'));
  const markBroken = (id: string) => setBroken((s) => new Set(s).add(id));

  return (
    <div className="ib-att">
      {items.map((a) => {
        const name = a.fileName ?? (a.kind === 'image' ? 'Imagen' : a.kind === 'video' ? 'Video' : a.kind === 'audio' ? 'Audio' : 'Archivo');
        const meta = [extOf(a.fileName).toUpperCase(), formatBytes(a.fileSize)].filter(Boolean).join(' · ');

        if (a.kind === 'location') {
          const lat = Number(a.meta.lat), lng = Number(a.meta.lng);
          const ok = Number.isFinite(lat) && Number.isFinite(lng);
          return <Card key={a.id} icon="pin" title={typeof a.meta.name === 'string' ? a.meta.name : 'Ubicación'} hint={ok ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : undefined}
            actions={ok ? <a className="ib-btn ib-btn--sm" href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noopener noreferrer nofollow">Ver en el mapa</a> : null} />;
        }
        if (a.kind === 'contact') return <Card key={a.id} icon="user" title={typeof a.meta.name === 'string' ? a.meta.name : 'Contacto compartido'} hint={typeof a.meta.phone === 'string' ? a.meta.phone : undefined} />;
        if (a.status !== 'stored') {
          const t = STATUS_TEXT[a.status] ?? STATUS_TEXT.failed!;
          const retention = a.errorCode === 'retention';
          return <Card key={a.id} icon={KIND_ICON[a.kind] ?? 'file'} title={retention ? 'Archivo eliminado por antigüedad' : t.title} hint={retention ? 'Se conserva 12 meses; el mensaje sigue aquí.' : t.hint} actions={null} />;
        }
        const download = <a key="d" className="ib-btn ib-btn--sm" href={src(a.id, true)}>Descargar</a>;

        if ((a.kind === 'image' || a.kind === 'sticker') && !broken.has(a.id)) {
          const idx = images.findIndex((x) => x.id === a.id);
          return (
            <button key={a.id} type="button" className={`ib-att-img${a.kind === 'sticker' ? ' is-sticker' : ''}`} onClick={() => setOpen(idx)} aria-label={`Ver ${name} ampliada`}
              style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src(a.id)} alt={name} loading="lazy" width={a.width ?? undefined} height={a.height ?? undefined} onError={() => markBroken(a.id)} ref={(el) => { if (el && el.complete && el.naturalWidth === 0) markBroken(a.id); }} />
            </button>
          );
        }
        if (a.kind === 'video' && !broken.has(a.id)) {
          return (
            <div key={a.id} className="ib-att-video">
              <video controls preload="metadata" playsInline src={src(a.id)} onError={() => markBroken(a.id)} ref={(el) => { if (el?.error) markBroken(a.id); }} aria-label={name} />
              <div className="ib-att-cap"><span>{name}{meta ? ` · ${meta}` : ''}</span>{download}</div>
            </div>
          );
        }
        if (a.kind === 'audio' && !broken.has(a.id)) {
          return (
            <div key={a.id} className="ib-att-audio">
              <span className="ib-att-cap"><Ico name="audio" size={16} /> {a.isVoice ? 'Nota de voz' : name}{meta && !a.isVoice ? ` · ${meta}` : ''}</span>
              <audio controls preload="none" src={src(a.id)} onError={() => markBroken(a.id)} ref={(el) => { if (el?.error) markBroken(a.id); }} aria-label={a.isVoice ? 'Nota de voz' : name} />
              {download}
            </div>
          );
        }
        // documentos, archivos y todo lo que el navegador no puede mostrar
        const playable = a.kind === 'image' || a.kind === 'sticker' || a.kind === 'video' || a.kind === 'audio';
        return <Card key={a.id} icon={KIND_ICON[a.kind] ?? 'file'} title={name} hint={playable ? `Vista previa no disponible${meta ? ` · ${meta}` : ''}` : meta || undefined}
          actions={<>{canView(a) ? <a className="ib-btn ib-btn--sm" href={src(a.id)} target="_blank" rel="noopener noreferrer">Ver</a> : null}{download}</>} />;
      })}
      {/* Fuera del panel (portal): así queda por ENCIMA de la cabecera de la aplicación y sus botones no quedan tapados ni tapan nada. */}
      {open !== null && images[open] ? createPortal(<div className="ib ib-portal"><Lightbox images={images} index={open} onClose={() => setOpen(null)} onIndex={setOpen} /></div>, document.body) : null}
    </div>
  );
}
