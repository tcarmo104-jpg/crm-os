'use client';

import { useEffect, useRef, useState } from 'react';
import { Ico } from './icons';
import { CHANNEL_LABEL, type ChannelKind } from '@/lib/inbox-view';

type Action = (fd: FormData) => Promise<void>;
export interface ComposerTemplate { id: string; name: string; body: string; paramCount: number }
export interface ComposerProps {
  conversationId: string; customerId: string; channel: ChannelKind;
  canReply: boolean; windowOpen: boolean; windowClosesLabel: string; dnc: boolean; paused: boolean;
  quickReplies: { id: string; title: string; body: string }[];
  templates: ComposerTemplate[];
  actions: { send: Action; note: Action; template: Action; createQuick: Action; deleteQuick: Action };
}

const EMOJIS = ['😀', '😊', '😂', '🙂', '😉', '😍', '🤗', '🤔', '😅', '😢', '😮', '🙏', '👍', '👌', '👏', '🙌', '💪', '🔥', '⭐', '✨', '🎉', '❤️', '💜', '✅',
  '❌', '⚠️', '📌', '📎', '📞', '📍', '🕐', '📅', '🛒', '📦', '🚚', '💳', '💰', '🎁', '🌟', '☀️'];

type Popover = null | 'emoji' | 'quick' | 'template';

export function Composer(p: ComposerProps) {
  const [mode, setMode] = useState<'message' | 'note'>('message');
  const [text, setText] = useState('');
  const [pop, setPop] = useState<Popover>(null);
  const [filter, setFilter] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // Cerrar los menús al hacer clic fuera o con Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setPop(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, []);

  if (!p.canReply) {
    return <div className="ib-composer ib-composer--readonly">Solo puedes leer esta conversación (tu rol no permite responder).</div>;
  }

  const note = mode === 'note';
  const blocked = !note && (!p.windowOpen || p.paused);
  const insert = (s: string) => {
    setText((prev) => (prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? `${prev} ${s}` : prev + s));
    setPop(null);
    area.current?.focus();
  };
  const quick = p.quickReplies.filter((q) => (q.title + ' ' + q.body).toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div ref={root} className={`ib-composer ib-composer--${mode}`}>
      <div className="ib-composer-tabs" role="tablist" aria-label="Tipo de mensaje">
        <button type="button" role="tab" aria-selected={!note} className={!note ? 'is-active' : ''} onClick={() => setMode('message')}>Mensaje al cliente</button>
        <button type="button" role="tab" aria-selected={note} className={note ? 'is-active' : ''} onClick={() => setMode('note')}><Ico name="lock" size={13} /> Nota interna</button>
      </div>

      {note ? (
        <p className="ib-composer-hint ib-composer-hint--note"><Ico name="lock" size={14} /> Solo tu equipo ve esta nota. <strong>No se envía al cliente.</strong></p>
      ) : p.paused ? (
        <p className="ib-composer-hint ib-composer-hint--warn">El canal está en pausa: no se pueden enviar mensajes.</p>
      ) : !p.windowOpen ? (
        <p className="ib-composer-hint ib-composer-hint--warn">{p.channel === 'whatsapp' ? <>Pasaron más de 24 h desde el último mensaje del cliente. WhatsApp solo permite enviar una <strong>plantilla aprobada</strong>{p.dnc ? '; y este cliente pidió no ser contactado' : ''}.</> : p.channel === 'gmail' ? <>Pasaron más de 30 días desde el último correo del cliente: espera a que vuelva a escribir.</> : <>Pasaron más de 24 h desde el último mensaje del cliente. {CHANNEL_LABEL[p.channel]} solo permite responder dentro de 24 h: espera a que vuelva a escribir.</>}</p>
      ) : p.dnc ? (
        <p className="ib-composer-hint ib-composer-hint--warn">Este cliente pidió no ser contactado: puedes responderle hasta {p.windowClosesLabel}, sin plantillas.</p>
      ) : (
        <p className="ib-composer-hint">Puedes escribir libremente hasta {p.windowClosesLabel}.</p>
      )}

      <form action={note ? p.actions.note : p.actions.send} className="ib-composer-form">
        <input type="hidden" name="conversationId" value={p.conversationId} />
        <input type="hidden" name="customerId" value={p.customerId} />
        <label className="sr-only" htmlFor="ib-body">{note ? 'Nota interna' : 'Mensaje'}</label>
        <textarea
          id="ib-body" ref={area} name="body" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={note ? 2000 : 4096}
          className="ib-textarea" disabled={blocked}
          placeholder={note ? 'Escribe una nota para tu equipo…' : blocked ? 'Usa una plantilla para volver a escribirle' : 'Escribe un mensaje…  (Ctrl + Enter para enviar)'}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (text.trim()) e.currentTarget.form?.requestSubmit(); } }}
        />
        <div className="ib-composer-bar">
          <div className="ib-tools">
            <button type="button" className="ib-icon-btn" disabled title="Adjuntar archivo: próximamente" aria-label="Adjuntar archivo (próximamente)"><Ico name="paperclip" /></button>
            <button type="button" className="ib-icon-btn" disabled title="Adjuntar imagen: próximamente" aria-label="Adjuntar imagen (próximamente)"><Ico name="image" /></button>
            <button type="button" className={`ib-icon-btn${pop === 'emoji' ? ' is-on' : ''}`} onClick={() => setPop(pop === 'emoji' ? null : 'emoji')} aria-label="Emojis" aria-expanded={pop === 'emoji'} disabled={blocked}><Ico name="smile" /></button>
            <button type="button" className={`ib-icon-btn${pop === 'quick' ? ' is-on' : ''}`} onClick={() => { setPop(pop === 'quick' ? null : 'quick'); setFilter(''); }} aria-label="Respuestas rápidas" aria-expanded={pop === 'quick'} disabled={blocked}><Ico name="bolt" /></button>
            {!note && p.channel === 'whatsapp' ? (
              <button type="button" className={`ib-btn ib-btn--ghost ib-btn--sm${pop === 'template' ? ' is-on' : ''}`} onClick={() => setPop(pop === 'template' ? null : 'template')} aria-expanded={pop === 'template'} disabled={p.dnc || p.paused}>Plantillas</button>
            ) : null}
          </div>
          <button type="submit" className="ib-send" disabled={blocked || text.trim() === ''}>
            {note ? <><Ico name="lock" size={15} /> Guardar nota</> : <><Ico name="send" size={15} /> Enviar</>}
          </button>
        </div>
      </form>

      {pop === 'emoji' ? (
        <div className="ib-pop" role="dialog" aria-label="Emojis">
          <div className="ib-emoji-grid">
            {EMOJIS.map((e) => <button type="button" key={e} onClick={() => insert(e)} aria-label={`Insertar ${e}`}>{e}</button>)}
          </div>
        </div>
      ) : null}

      {pop === 'quick' ? (
        <div className="ib-pop ib-pop--wide" role="dialog" aria-label="Respuestas rápidas">
          <input className="ib-input" placeholder="Buscar respuesta…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Buscar respuesta rápida" />
          <ul className="ib-quick-list">
            {quick.length === 0 ? <li className="ib-muted">{p.quickReplies.length === 0 ? 'Aún no hay respuestas rápidas. Crea la primera abajo.' : 'Sin resultados.'}</li> : quick.map((q) => (
              <li key={q.id}>
                <button type="button" className="ib-quick-item" onClick={() => insert(q.body)}><strong>{q.title}</strong><span>{q.body}</span></button>
                <form action={p.actions.deleteQuick}>
                  <input type="hidden" name="id" value={q.id} /><input type="hidden" name="conversationId" value={p.conversationId} /><button className="ib-icon-btn" type="submit" aria-label={`Eliminar la respuesta ${q.title}`} title="Eliminar"><Ico name="x" size={14} /></button>
                </form>
              </li>
            ))}
          </ul>
          <details className="ib-quick-new">
            <summary>+ Nueva respuesta rápida</summary>
            <form action={p.actions.createQuick}>
              <input type="hidden" name="conversationId" value={p.conversationId} /><input className="ib-input" name="title" maxLength={60} required placeholder="Título corto (ej. Saludo)" aria-label="Título" />
              <textarea className="ib-input" name="body" maxLength={1000} required rows={3} defaultValue={text} placeholder="Texto de la respuesta" aria-label="Texto" />
              <button className="ib-btn ib-btn--primary ib-btn--sm" type="submit">Guardar</button>
            </form>
          </details>
        </div>
      ) : null}

      {pop === 'template' ? (
        <div className="ib-pop ib-pop--wide" role="dialog" aria-label="Plantillas aprobadas">
          {p.templates.length === 0 ? <p className="ib-muted">No hay plantillas aprobadas para este canal. Un administrador las agrega en Configuración → Canales.</p> : (
            <ul className="ib-quick-list">
              {p.templates.map((t) => (
                <li key={t.id} className="ib-tpl">
                  <details>
                    <summary><strong>{t.name}</strong></summary>
                    <form action={p.actions.template}>
                      <input type="hidden" name="conversationId" value={p.conversationId} /><input type="hidden" name="templateId" value={t.id} /><p className="ib-muted ib-pre">{t.body}</p>
                      {Array.from({ length: t.paramCount }, (_, i) => (
                        <input key={i} className="ib-input" name={`p${i + 1}`} maxLength={500} required placeholder={`Dato {{${i + 1}}}`} aria-label={`Dato ${i + 1}`} />
                      ))}
                      <button className="ib-btn ib-btn--primary ib-btn--sm" type="submit">Enviar plantilla</button>
                    </form>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
