import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { siteUrl } from '@/lib/env';
import { channelTokenStatus, listChannels, listTemplates } from '@/repositories/inbox';
import { Notice, SubmitButton } from '@/components/ui';
import { createChannelAction, createTemplateAction, saveTokenAction, setChannelStatusAction, setTemplateStatusAction } from './actions';

export const metadata: Metadata = { title: 'Canales (WhatsApp)' };

export default async function ChannelsPage() {
  const session = (await getSession())!;
  if (!can(session, 'settings:manage')) redirect('/inbox');
  const org = session.active!;
  const db = await createClient();
  const [channels, tokens, templates, flash] = await Promise.all([listChannels(db, org.orgId), channelTokenStatus(db, org.orgId), listTemplates(db, org.orgId), readFlash()]);
  const webhook = `${siteUrl()}/api/webhooks/meta`;
  const secretOk = Boolean(process.env.META_APP_SECRET?.trim());
  const verifyOk = Boolean(process.env.META_VERIFY_TOKEN?.trim());

  return (
    <>
      <header className="page-head">
        <h1>Canales (WhatsApp)</h1>
        <p className="muted">Conecta tu número de WhatsApp Business (API de Meta). Los mensajes que lleguen crean clientes y leads solos.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-labelledby="webhook-title">
        <div className="panel-head"><h2 id="webhook-title">Datos para configurar Meta</h2></div>
        <dl className="kv">
          <dt>URL de devolución de llamada (webhook)</dt><dd><code>{webhook}</code></dd>
          <dt>Campo a suscribir</dt><dd><code>messages</code></dd>
          <dt>App Secret en el servidor</dt><dd>{secretOk ? <span className="badge badge-ok">Configurado</span> : <span className="badge badge-danger">Falta META_APP_SECRET</span>}</dd>
          <dt>Token de verificación en el servidor</dt><dd>{verifyOk ? <span className="badge badge-ok">Configurado</span> : <span className="badge badge-danger">Falta META_VERIFY_TOKEN</span>}</dd>
        </dl>
        {!secretOk || !verifyOk ? <p className="hint">Agrega las variables que faltan en Vercel (Settings → Environment Variables) y vuelve a desplegar. Mientras falte el App Secret, el sistema rechaza todos los webhooks por seguridad.</p> : null}
      </section>

      <section className="panel" aria-labelledby="new-title">
        <details open={channels.length === 0}>
          <summary><h2 id="new-title" style={{ display: 'inline', fontSize: '1rem' }}>Conectar un número</h2></summary>
          <form action={createChannelAction} className="stack">
            <div className="field"><label className="label" htmlFor="ch-name">Nombre (para ti)</label><input id="ch-name" name="name" className="input" maxLength={80} required placeholder="Ventas" /></div>
            <div className="field"><label className="label" htmlFor="ch-pid">ID del número de teléfono (Meta)</label><input id="ch-pid" name="phoneNumberId" className="input" inputMode="numeric" required placeholder="109876543210" /></div>
            <div className="field"><label className="label" htmlFor="ch-phone">Número visible (opcional)</label><input id="ch-phone" name="displayPhone" className="input" maxLength={30} placeholder="+57 300 000 0000" /></div>
            <div className="field"><label className="label" htmlFor="ch-token">Token de acceso permanente</label><input id="ch-token" name="token" className="input" type="password" autoComplete="off" placeholder="EAAB…" /><p className="hint">Se guarda cifrado en tránsito y nadie puede volver a verlo, ni siquiera tú: solo el servidor lo usa para enviar.</p></div>
            <div><SubmitButton pendingLabel="Guardando…">Conectar</SubmitButton></div>
          </form>
        </details>
      </section>

      {channels.map((c) => (
        <section className="panel" key={c.id} aria-label={`Canal ${c.name}`}>
          <div className="panel-head">
            <h2>{c.name} <span className={`badge ${c.status === 'active' ? 'badge-ok' : 'badge-warn'}`}>{c.status === 'active' ? 'Activo' : 'En pausa'}</span></h2>
            <form action={setChannelStatusAction}>
              <input type="hidden" name="channelId" value={c.id} /><input type="hidden" name="status" value={c.status === 'active' ? 'paused' : 'active'} />
              <button className="btn btn-secondary btn-sm" type="submit">{c.status === 'active' ? 'Pausar' : 'Activar'}</button>
            </form>
          </div>
          <p className="muted small">ID {c.externalId}{c.displayPhone ? ` · ${c.displayPhone}` : ''} · Token: {tokens.get(c.id) ? <span className="badge badge-ok">guardado</span> : <span className="badge badge-danger">falta</span>}</p>
          <details>
            <summary className="small">{tokens.get(c.id) ? 'Cambiar el token' : 'Guardar el token'}</summary>
            <form action={saveTokenAction} className="stack">
              <input type="hidden" name="channelId" value={c.id} />
              <label className="sr-only" htmlFor={`tk-${c.id}`}>Token</label>
              <input id={`tk-${c.id}`} name="token" className="input" type="password" autoComplete="off" required placeholder="EAAB…" />
              <button className="btn btn-secondary btn-sm" type="submit">Guardar token</button>
            </form>
          </details>

          <h3>Plantillas aprobadas por Meta</h3>
          {templates.filter((t) => t.channelId === c.id).length === 0 ? <p className="muted small">Sin plantillas. Sin ellas solo puedes responder dentro de las 24 h.</p> : (
            <ul className="id-list">
              {templates.filter((t) => t.channelId === c.id).map((t) => (
                <li key={t.id}>
                  <span><strong>{t.name}</strong> <span className="small muted">({t.language})</span> {t.status === 'disabled' ? <span className="badge">Desactivada</span> : null}<br /><span className="small muted">{t.body}</span></span>
                  <form action={setTemplateStatusAction}>
                    <input type="hidden" name="templateId" value={t.id} /><input type="hidden" name="status" value={t.status === 'approved' ? 'disabled' : 'approved'} />
                    <button className="btn btn-ghost btn-sm" type="submit">{t.status === 'approved' ? 'Desactivar' : 'Activar'}</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary className="small">Agregar una plantilla</summary>
            <form action={createTemplateAction} className="stack">
              <input type="hidden" name="channelId" value={c.id} />
              <p className="hint">Copia el nombre, el idioma y el texto EXACTOS de la plantilla ya aprobada en Meta. Los datos variables se escriben {'{{1}}'}, {'{{2}}'}…</p>
              <div className="grid-3">
                <div className="field"><label className="label" htmlFor={`tn-${c.id}`}>Nombre en Meta</label><input id={`tn-${c.id}`} name="name" className="input" required placeholder="seguimiento_pedido" /></div>
                <div className="field"><label className="label" htmlFor={`tl-${c.id}`}>Idioma</label><input id={`tl-${c.id}`} name="language" className="input" defaultValue="es" required /></div>
              </div>
              <div className="field"><label className="label" htmlFor={`tb-${c.id}`}>Texto</label><textarea id={`tb-${c.id}`} name="body" className="input" rows={3} maxLength={1024} required placeholder="Hola {{1}}, seguimos con tu pedido {{2}}" /></div>
              <button className="btn btn-secondary btn-sm" type="submit">Guardar plantilla</button>
            </form>
          </details>
        </section>
      ))}
    </>
  );
}
