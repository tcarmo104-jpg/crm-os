'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { SEND_RULES, acceptFor, captionMode, extOf, formatBytes, mimeFromName, validateBatch, validateOutgoing, type MediaKind } from '@/lib/media';
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
  /** Envío de archivos. Si no se pasa, los botones 📎 quedan deshabilitados. */
  attach?: {
    prepare: (i: { conversationId: string; fileName: string; mime: string; size: number; isVoice?: boolean }) => Promise<{ ok: true; uploadId: string; path: string; token: string } | { ok: false; message: string }>;
    cancel: (uploadId: string) => Promise<void>;
    send: (i: { conversationId: string; uploadIds: string[]; caption?: string }) => Promise<{ ok: true; note?: string } | { ok: false; message: string }>;
  };
}

interface PendingFile { key: string; name: string; size: number; mime: string; preview: string | null; status: 'uploading' | 'ready' | 'error'; uploadId?: string; error?: string; isVoice?: boolean }
const BUCKET = 'inbox-media';

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
  const picker = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const filesRef = useRef<PendingFile[]>([]);
  filesRef.current = files;
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { recStreamRef.current?.getTracks().forEach((t) => t.stop()); if (recTimerRef.current) clearInterval(recTimerRef.current); }, []);
  // El navegador sube directo al bucket con un enlace firmado por el servidor (sin sesión ni llaves propias).
  const storage = useMemo(() => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(BUCKET), []);
  useEffect(() => () => { for (const f of filesRef.current) if (f.preview) URL.revokeObjectURL(f.preview); }, []);

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
  const rules = SEND_RULES[p.channel];
  const canAttach = Boolean(p.attach) && !note && !blocked;
  const ready = files.filter((f) => f.status === 'ready');
  const uploading = files.some((f) => f.status === 'uploading');
  const patch = (key: string, change: Partial<PendingFile>) => setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...change } : f)));
  const drop = (f: PendingFile) => { if (f.preview) URL.revokeObjectURL(f.preview); if (f.uploadId) void p.attach?.cancel(f.uploadId); setFiles((prev) => prev.filter((x) => x.key !== f.key)); setFileError(null); };

  const addFiles = async (list: FileList | File[] | null, only?: MediaKind, isVoice = false) => {
    if (!p.attach || !list) return;
    const picked = Array.from(list);
    if (picked.length === 0) return;
    setFileError(null);
    const total = validateBatch(p.channel, [...files.map((f) => f.size), ...picked.map((f) => f.size)]);
    if (!total.ok) { setFileError(total.message); return; }
    for (const file of picked) {
      const mime = file.type || mimeFromName(file.name);
      const check = validateOutgoing({ channel: p.channel, fileName: file.name, mime, size: file.size });
      if (!check.ok || (only && check.kind !== only)) {
        setFileError(check.ok ? 'Aquí solo puedes adjuntar imágenes.' : isVoice ? `Tu navegador grabó el audio en un formato que ${CHANNEL_LABEL[p.channel]} no acepta. Prueba grabar desde otro navegador (Firefox suele funcionar), o adjunta una nota de voz ya grabada como archivo.` : check.message);
        continue;
      }
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = check.kind === 'image' && check.mime !== 'image/heic' ? URL.createObjectURL(file) : null;
      setFiles((prev) => [...prev, { key, name: file.name, size: file.size, mime: check.mime, preview, status: 'uploading', isVoice }]);
      try {
        const prep = await p.attach.prepare({ conversationId: p.conversationId, fileName: file.name, mime: check.mime, size: file.size, isVoice });
        if (!prep.ok) { patch(key, { status: 'error', error: prep.message }); setFileError(prep.message); continue; }
        patch(key, { uploadId: prep.uploadId });
        const up = await storage.uploadToSignedUrl(prep.path, prep.token, file, { contentType: check.mime });
        if (up.error) { patch(key, { status: 'error', error: 'No se pudo subir el archivo. Inténtalo de nuevo.' }); setFileError('No se pudo subir el archivo. Inténtalo de nuevo.'); void p.attach.cancel(prep.uploadId); continue; }
        patch(key, { status: 'ready' });
      } catch { patch(key, { status: 'error', error: 'No se pudo subir el archivo. Revisa tu conexión e inténtalo de nuevo.' }); setFileError('No se pudo subir el archivo. Revisa tu conexión e inténtalo de nuevo.'); }
    }
  };
  // Formato preferido para grabar: audio/ogg (lo que WhatsApp/Messenger/Instagram esperan de una nota de voz)
  // si el navegador lo sabe grabar (Firefox); si no, lo mejor que el navegador ofrezca (Chrome/Edge/Safari
  // graban en otro formato — se valida igual al terminar, y si ese canal no lo acepta se avisa con claridad
  // en vez de fingir que se envió).
  const RECORD_MIME_CANDIDATES = ['audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  const MAX_RECORD_SECONDS = 300;

  const startRecording = async () => {
    if (recording || !canAttach) return;
    setFileError(null);
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setFileError('Este navegador no puede grabar audio.'); return;
    }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setFileError('No se pudo acceder al micrófono. Revisa los permisos del navegador para este sitio.'); return; }
    const mimeType = RECORD_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recChunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) recChunksRef.current.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
      const blob = new Blob(recChunksRef.current, { type: rec.mimeType || mimeType || 'audio/webm' });
      recChunksRef.current = [];
      setRecording(false); setRecSeconds(0);
      if (blob.size === 0) return;   // se canceló antes de grabar nada real
      const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
      void addFiles([new File([blob], `nota-de-voz.${ext}`, { type: blob.type })], 'audio', true);
    };
    recorderRef.current = rec; recStreamRef.current = stream;
    rec.start();
    setRecording(true); setRecSeconds(0);
    recTimerRef.current = setInterval(() => setRecSeconds((s) => { if (s + 1 >= MAX_RECORD_SECONDS) { rec.stop(); return s; } return s + 1; }), 1000);
  };
  /** Detiene y ENVÍA lo grabado (pasa a la vista previa, como cualquier archivo adjuntado). */
  const stopRecording = () => recorderRef.current?.state === 'recording' && recorderRef.current.stop();
  /** Descarta la grabación sin agregarla a los adjuntos. */
  const cancelRecording = () => {
    const rec = recorderRef.current;
    if (rec) { rec.ondataavailable = null; rec.onstop = () => { recStreamRef.current?.getTracks().forEach((t) => t.stop()); }; if (rec.state === 'recording') rec.stop(); }
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    recChunksRef.current = [];
    setRecording(false); setRecSeconds(0);
  };
  const fmtRecTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const openPicker = (only?: MediaKind) => {
    const el = picker.current; if (!el) return;
    el.accept = acceptFor(p.channel, only); el.multiple = rules.maxFiles > 1; el.dataset.only = only ?? ''; el.value = ''; el.click();
  };
  const sendFiles = async () => {
    if (!p.attach || busy || uploading || ready.length === 0) return;
    setBusy(true); setFileError(null);
    const res = await p.attach.send({ conversationId: p.conversationId, uploadIds: ready.map((f) => f.uploadId!).filter(Boolean), caption: text.trim() || undefined });
    setBusy(false);
    if (!res.ok) { setFileError(res.message); return; }
    for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles([]); setText(''); startTransition(() => router.refresh());
  };
  const kind0: MediaKind = ready[0]?.mime.startsWith('audio/') ? 'audio' : 'image';
  const cap = captionMode(p.channel, kind0);
  const separateHint = ready.length > 0 && text.trim() !== '' && !cap.inline;
  const quick = p.quickReplies.filter((q) => (q.title + ' ' + q.body).toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div ref={root} className={`ib-composer ib-composer--${mode}`} onDragOver={(e) => { if (canAttach) e.preventDefault(); }} onDrop={(e) => { if (canAttach && e.dataTransfer.files.length > 0) { e.preventDefault(); void addFiles(e.dataTransfer.files); } }}>
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

      <form action={note ? p.actions.note : p.actions.send} className="ib-composer-form" onSubmit={(e) => { if (!note && files.length > 0) { e.preventDefault(); void sendFiles(); } }}>
        <input ref={picker} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { const only = (e.currentTarget.dataset.only || undefined) as MediaKind | undefined; void addFiles(e.currentTarget.files, only); }} />
        {files.length > 0 ? (
          <ul className="ib-chips" aria-label="Archivos por enviar">
            {files.map((f) => (
              <li key={f.key} className={`ib-chip is-${f.status}`}>
                {f.preview
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={f.preview} alt="" className="ib-chip-img" />
                  : <span className="ib-chip-ico"><Ico name={f.mime.startsWith('video/') ? 'video' : f.mime.startsWith('audio/') ? 'audio' : 'file'} size={20} /></span>}
                <span className="ib-chip-text"><strong>{f.name}</strong><small>{[extOf(f.name).toUpperCase(), formatBytes(f.size)].filter(Boolean).join(' · ')} · {f.status === 'uploading' ? 'Subiendo…' : f.status === 'ready' ? 'Listo para enviar' : (f.error ?? 'Error')}</small></span>
                <button type="button" className="ib-chip-x" aria-label={`Quitar ${f.name}`} onClick={() => drop(f)} disabled={busy}><Ico name="x" size={14} /></button>
              </li>
            ))}
          </ul>
        ) : null}
        {separateHint ? <p className="ib-composer-hint">{p.channel === 'whatsapp' ? 'Los audios no llevan texto en WhatsApp:' : 'Este canal no permite texto y archivo juntos:'} el texto se enviará como un mensaje aparte.</p> : null}
        {fileError ? <p className="ib-composer-hint ib-composer-hint--warn" role="alert">{fileError}</p> : null}
        <input type="hidden" name="conversationId" value={p.conversationId} />
        <input type="hidden" name="customerId" value={p.customerId} />
        <label className="sr-only" htmlFor="ib-body">{note ? 'Nota interna' : 'Mensaje'}</label>
        <textarea
          id="ib-body" ref={area} name="body" value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={note ? 2000 : 4096}
          className="ib-textarea" disabled={blocked}
          placeholder={note ? 'Escribe una nota para tu equipo…' : blocked ? 'Usa una plantilla para volver a escribirle' : 'Escribe un mensaje…  (Ctrl + Enter para enviar)'}
          onPaste={(e) => { if (canAttach && e.clipboardData.files.length > 0) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (text.trim() || ready.length > 0) e.currentTarget.form?.requestSubmit(); } }}
        />
        {recording ? (
          <div className="ib-record-bar" role="status">
            <span className="ib-record-dot" aria-hidden="true" />
            <span>Grabando… {fmtRecTime(recSeconds)}</span>
            <button type="button" className="ib-btn ib-btn--ghost ib-btn--sm" onClick={cancelRecording}>Cancelar</button>
            <button type="button" className="ib-btn ib-btn--primary ib-btn--sm" onClick={stopRecording}><Ico name="send" size={14} /> Detener</button>
          </div>
        ) : (
          <div className="ib-composer-bar">
            <div className="ib-tools">
              <button type="button" className="ib-icon-btn" disabled={!canAttach || busy} title={canAttach ? 'Adjuntar archivo' : 'Adjuntar archivo no disponible'} aria-label="Adjuntar archivo" onClick={() => openPicker()}><Ico name="paperclip" /></button>
              <button type="button" className="ib-icon-btn" disabled={!canAttach || busy} title={canAttach ? 'Adjuntar imagen' : 'Adjuntar imagen no disponible'} aria-label="Adjuntar imagen" onClick={() => openPicker('image')}><Ico name="image" /></button>
              <button type="button" className="ib-icon-btn" disabled={!canAttach || busy || SEND_RULES[p.channel].groups.every((g) => g.kind !== 'audio')} title={canAttach ? 'Grabar una nota de voz' : 'Grabar audio no disponible'} aria-label="Grabar una nota de voz" onClick={() => void startRecording()}><Ico name="mic" /></button>
              <button type="button" className={`ib-icon-btn${pop === 'emoji' ? ' is-on' : ''}`} onClick={() => setPop(pop === 'emoji' ? null : 'emoji')} aria-label="Emojis" aria-expanded={pop === 'emoji'} disabled={blocked}><Ico name="smile" /></button>
              <button type="button" className={`ib-icon-btn${pop === 'quick' ? ' is-on' : ''}`} onClick={() => { setPop(pop === 'quick' ? null : 'quick'); setFilter(''); }} aria-label="Respuestas rápidas" aria-expanded={pop === 'quick'} disabled={blocked}><Ico name="bolt" /></button>
              {!note && p.channel === 'whatsapp' ? (
                <button type="button" className={`ib-btn ib-btn--ghost ib-btn--sm${pop === 'template' ? ' is-on' : ''}`} onClick={() => setPop(pop === 'template' ? null : 'template')} aria-expanded={pop === 'template'} disabled={p.dnc || p.paused}>Plantillas</button>
              ) : null}
            </div>
            <button type="submit" className="ib-send" disabled={blocked || busy || uploading || (text.trim() === '' && (note || ready.length === 0))} aria-busy={busy}>
              {note ? <><Ico name="lock" size={15} /> Guardar nota</> : busy ? <>Enviando…</> : <><Ico name="send" size={15} /> {files.length > 0 ? 'Enviar archivo' : 'Enviar'}</>}
            </button>
          </div>
        )}
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
