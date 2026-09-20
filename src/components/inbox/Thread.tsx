import { linkify, groupByDay, STATUS_TEXT, type ThreadItem } from '@/lib/thread';
import { Ico } from './icons';
import { ThreadScroll } from './ThreadScroll';

const MEDIA_ICON: Record<string, string> = { image: 'image', video: 'video', audio: 'audio', document: 'file', sticker: 'image', other: 'file' };
const MEDIA_NAME: Record<string, string> = { image: 'Imagen', video: 'Video', audio: 'Audio', document: 'Documento', sticker: 'Sticker', other: 'Archivo' };

function Text({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((p, i) => p.t === 'link'
        ? <a key={i} href={p.v} target="_blank" rel="noopener noreferrer nofollow">{p.v}</a>
        : <span key={i}>{p.v}</span>)}
    </>
  );
}

export function Thread({
  items, timeZone, nameOf, resetKey, emptyText,
}: { items: ThreadItem[]; timeZone: string; nameOf: (id: string | null) => string; resetKey: string; emptyText: string }) {
  const time = new Intl.DateTimeFormat('es', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const groups = groupByDay(items, timeZone);

  return (
    <ThreadScroll watch={items.length} resetKey={resetKey}>
      {groups.length === 0 ? <p className="ib-thread-empty">{emptyText}</p> : groups.map((g) => (
        <section key={g.label} className="ib-day" aria-label={g.label}>
          <h3 className="ib-day-label"><span>{g.label}</span></h3>
          {g.items.map((it) => {
            if (it.kind === 'event') return <p key={it.id} className="ib-event">{it.text} · {time.format(new Date(it.at))}</p>;
            if (it.kind === 'note') {
              return (
                <article key={it.id} className="ib-note" aria-label="Nota interna">
                  <header><Ico name="lock" size={13} /> <strong>Nota interna</strong> · {nameOf(it.authorId)} · {time.format(new Date(it.at))}</header>
                  <p><Text text={it.body} /></p>
                  <footer>Solo tu equipo la ve · no se envió al cliente</footer>
                </article>
              );
            }
            const out = it.direction === 'outbound';
            const cls = `ib-bubble${out ? ' is-out' : ''}${it.auto ? ' is-auto' : ''}${it.status === 'failed' ? ' is-failed' : ''}`;
            return (
              <article key={it.id} className={cls}>
                {it.auto ? <header className="ib-bubble-tag"><Ico name="bot" size={13} /> Respuesta automática</header> : null}
                {it.template ? <header className="ib-bubble-tag">Plantilla</header> : null}
                {it.media ? (
                  <div className="ib-media">
                    <span className="ib-media-ico"><Ico name={MEDIA_ICON[it.media] ?? 'file'} size={22} /></span>
                    <span className="ib-media-text"><strong>{MEDIA_NAME[it.media]}</strong><small>Vista previa no disponible todavía</small></span>
                  </div>
                ) : null}
                <p className="ib-bubble-text"><Text text={it.body} /></p>
                <footer>
                  {time.format(new Date(it.at))}
                  {out && !it.auto ? ` · ${nameOf(it.sentBy)}` : ''}
                  {out && STATUS_TEXT[it.status] ? ` · ${STATUS_TEXT[it.status]}${it.status === 'delivered' ? ' ✓✓' : it.status === 'read' ? ' ✓✓' : it.status === 'sent' ? ' ✓' : ''}` : ''}
                </footer>
                {it.status === 'failed' && it.error ? <p className="ib-bubble-error">{it.error}</p> : null}
              </article>
            );
          })}
        </section>
      ))}
    </ThreadScroll>
  );
}
