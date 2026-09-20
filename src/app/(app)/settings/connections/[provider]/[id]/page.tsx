import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PROVIDER_NAME, stateInfo, timeAgo, webhookUrl } from '@/lib/connections';
import { redirectUri } from '@/lib/social';
import { siteUrl } from '@/lib/env';
import { readFlash } from '@/lib/flash';
import { encryptionEnabled } from '@/lib/secrets';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { channelTokenStatus, listChannels, listConnectionEvents } from '@/repositories/inbox';
import { InboxFeed, KV, Logo, Row, StatusPill } from '@/components/connections/parts';
import { Notice, SubmitButton } from '@/components/ui';
import { disconnectConnectionAction, saveConnectionTokenAction, setBusinessAccountAction, syncGmailAction, toggleConnectionStatusAction, verifyConnectionAction } from '../../actions';
import '../../connections.css';

export const metadata: Metadata = { title: 'Configurar conexión' };
const KINDS = ['whatsapp', 'facebook', 'instagram', 'gmail'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ConfigureConnectionPage({ params }: { params: Promise<{ provider: string; id: string }> }) {
  const { provider, id } = await params;
  const session = (await getSession())!;
  if (!can(session, 'settings:manage')) redirect('/inbox');
  if (!UUID.test(id) || !(KINDS as readonly string[]).includes(provider)) notFound();
  const org = session.active!;
  const db = await createClient();
  const [channels, tokens, flash] = await Promise.all([listChannels(db, org.orgId), channelTokenStatus(db, org.orgId), readFlash()]);
  const c = channels.find((x) => x.id === id);
  if (!c || c.kind !== provider) notFound();
  const events = await listConnectionEvents(db, id, 15);
  const info = stateInfo(c.connectionStatus);
  const pname = PROVIDER_NAME[c.kind]!;
  const back = `/settings/connections/${c.kind}/${id}`;
  const oauthStart = c.kind === 'gmail' ? '/api/connections/google/start' : '/api/connections/meta/start';
  const now = new Date();
  const hook = webhookUrl(siteUrl());
  const yes = (v: boolean, ok: string, no: string) => <span className={`cx-pill cx-pill--${v ? 'ok' : 'danger'}`}><i aria-hidden="true" />{v ? ok : no}</span>;
  const quality = typeof c.metadata.quality_rating === 'string' ? c.metadata.quality_rating : null;
  const disconnected = c.connectionStatus === 'disconnected';

  return (
    <div className="cx cx-detail">
      <nav aria-label="Ruta"><Link href="/settings/connections" className="cx-back">← Conexiones</Link></nav>
      <header className="cx-head">
        <div className="cx-title">
          <Logo provider={c.kind} size={48} />
          <div>
            <h1>{c.kind === 'gmail' ? c.externalId : c.accountName ?? c.name}</h1>
            <p className="cx-muted">{pname} · {c.kind === 'gmail' ? 'Cuenta de correo' : c.kind === 'facebook' ? `Página ${c.externalId}` : c.displayPhone ?? `ID ${c.externalId}`}</p>
          </div>
        </div>
        <div className="cx-title-side"><StatusPill state={c.connectionStatus} /><InboxFeed live={c.connectionStatus === 'connected' && c.status === 'active'} /></div>
      </header>

      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}
      <p className={`cx-banner cx-banner--${info.tone}`}>{info.message(pname)}</p>

      <section className="cx-panel" aria-labelledby="cx-estado">
        <div className="cx-panel-head">
          <h2 id="cx-estado">Estado de la conexión</h2>
          <div className="cx-actions">
          {!disconnected && c.kind === 'gmail' ? <form action={syncGmailAction}><input type="hidden" name="channelId" value={id} /><input type="hidden" name="returnTo" value={back} /><SubmitButton className="cx-btn cx-btn--secondary cx-btn--sm" pendingLabel="Sincronizando…">Sincronizar ahora</SubmitButton></form> : null}
          {!disconnected ? <form action={verifyConnectionAction}><input type="hidden" name="channelId" value={id} /><input type="hidden" name="returnTo" value={back} /><SubmitButton className="cx-btn cx-btn--secondary cx-btn--sm" pendingLabel="Verificando…">Verificar ahora</SubmitButton></form> : null}
          </div>
        </div>
        <KV>
          {c.kind === 'whatsapp' ? <>
            <Row k="Nombre verificado">{c.accountName ?? <span className="cx-muted">Aún no verificado</span>}</Row>
            <Row k="Número">{c.displayPhone ?? <span className="cx-muted">—</span>}</Row>
            <Row k="ID del número (phone_number_id)"><code>{c.externalId}</code></Row>
            <Row k="ID de la cuenta de WhatsApp Business">{c.businessAccountId ? <code>{c.businessAccountId}</code> : <span className="cx-muted">Sin indicar</span>}</Row>
            {quality ? <Row k="Calidad del número">{quality === 'GREEN' ? 'Alta' : quality === 'YELLOW' ? 'Media' : quality === 'RED' ? 'Baja' : quality}</Row> : null}
          </> : null}
          {c.kind === 'facebook' ? <>
            <Row k="Nombre de la página">{c.accountName ?? c.name}</Row>
            <Row k="ID de la página"><code>{c.externalId}</code></Row>
          </> : null}
          {c.kind === 'instagram' ? <>
            <Row k="Usuario de Instagram">{c.displayPhone ?? c.accountName ?? c.name}</Row>
            <Row k="ID de la cuenta"><code>{c.externalId}</code></Row>
            <Row k="Página de Facebook asociada">{typeof c.metadata.page_id === 'string' ? <code>{c.metadata.page_id}</code> : <span className="cx-muted">Sin datos</span>}</Row>
          </> : null}
          {c.kind === 'gmail' ? <Row k="Correo conectado"><strong>{c.externalId}</strong></Row> : null}
          <Row k="Conectado desde">{timeAgo(c.connectedAt, now)}</Row>
          <Row k="Última sincronización">{timeAgo(c.lastSyncAt, now)}</Row>
          <Row k={c.kind === 'gmail' ? 'Último correo recibido' : 'Último mensaje recibido'}>{timeAgo(c.lastWebhookAt, now)}</Row>
          <Row k="Última verificación">{timeAgo(c.lastCheckedAt, now)}</Row>
          <Row k="Envío">{c.status === 'active' ? 'Activo' : 'En pausa'}</Row>
        </KV>
      </section>

      <section className="cx-panel" aria-labelledby="cx-webhook">
        {c.kind === 'gmail' ? <>
          <h2 id="cx-webhook">Recepción de correos</h2>
          <p className="cx-hint">Gmail no envía avisos al CRM: el CRM revisa tu bandeja cada vez que corre la tarea programada, y al pulsar «Sincronizar ahora». Solo trae correos directos de personas (no promociones, notificaciones ni tus enviados) y los une al cliente que tenga ese correo.</p>
          <KV>
            <Row k="Credenciales de Google (servidor)">{yes(Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim()), 'Configuradas', 'Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET')}</Row>
            <Row k="URI de redirección autorizada"><code className="cx-copy">{redirectUri(siteUrl(), 'google')}</code></Row>
          </KV>
        </> : <>
          <h2 id="cx-webhook">Recepción de mensajes (webhook)</h2>
          <p className="cx-hint">{c.kind === 'whatsapp' ? 'En Meta → tu app → WhatsApp → Configuración → Webhook, pega esta dirección y el token de verificación, y suscríbete al campo messages. Al verificar, el CRM también suscribe tu app a la cuenta automáticamente.' : 'En Meta → tu app → Webhooks, pega esta dirección y el token de verificación. Producto «Page»: messages, messaging_postbacks, message_deliveries, message_reads. Producto «Instagram»: messages. Al verificar, el CRM suscribe tu app a los mensajes de la página automáticamente.'}</p>
          <KV>
            <Row k="URL de devolución de llamada">{hook ? <code className="cx-copy">{hook}</code> : <span className="cx-alert">Define NEXT_PUBLIC_SITE_URL (con https://) en el servidor.</span>}</Row>
            <Row k="Token de verificación (servidor)">{yes(Boolean(process.env.META_VERIFY_TOKEN?.trim()), 'Configurado', 'Falta META_VERIFY_TOKEN')}</Row>
            <Row k="App Secret (servidor)">{yes(Boolean(process.env.META_APP_SECRET?.trim()), 'Configurado', 'Falta META_APP_SECRET')}</Row>
            <Row k="ID de la app">{process.env.META_APP_ID?.trim() ? <span className="cx-pill cx-pill--ok"><i aria-hidden="true" />Configurado</span> : <span className="cx-muted">{c.kind === 'whatsapp' ? 'No definido: se comprueba que haya alguna app suscrita' : 'Falta META_APP_ID'}</span>}</Row>
          </KV>
          {c.kind === 'whatsapp' ? (
            <form action={setBusinessAccountAction} className="cx-inline">
              <input type="hidden" name="channelId" value={id} /><input type="hidden" name="returnTo" value={back} />
              <label>ID de la cuenta de WhatsApp Business<input className="cx-input" name="businessAccountId" inputMode="numeric" defaultValue={c.businessAccountId ?? ''} required placeholder="123456789012345" /></label>
              <SubmitButton className="cx-btn cx-btn--secondary cx-btn--sm" pendingLabel="Guardando…">Guardar y verificar</SubmitButton>
            </form>
          ) : null}
        </>}
      </section>

      {!disconnected ? (
        <section className="cx-panel" aria-labelledby="cx-cred">
          <h2 id="cx-cred">Credenciales</h2>
          <p>{c.kind === 'gmail' ? 'Acceso a Gmail' : 'Token de acceso'}: {yes(Boolean(tokens.get(id)), 'Guardado', 'No guardado')} <span className="cx-hint">· {encryptionEnabled() ? 'cifrado en la base de datos' : 'protegido por el acceso a la base de datos'}. Nunca se muestra.</span></p>
          {c.kind === 'whatsapp' ? (
            <form action={saveConnectionTokenAction} className="cx-inline">
              <input type="hidden" name="channelId" value={id} /><input type="hidden" name="returnTo" value={back} />
              <label>{tokens.get(id) ? 'Reemplazar el token' : 'Guardar el token'}<input className="cx-input" name="token" type="password" autoComplete="off" required placeholder="EAAB…" /></label>
              <SubmitButton className="cx-btn cx-btn--secondary cx-btn--sm" pendingLabel="Guardando y verificando…">Guardar y verificar</SubmitButton>
            </form>
          ) : (
            <p><a className="cx-btn cx-btn--secondary cx-btn--sm" href={oauthStart}>Volver a autorizar con {c.kind === 'gmail' ? 'Google' : 'Meta'}</a> <span className="cx-hint">Úsalo si el acceso venció o cambiaste permisos. No hay que copiar ningún token.</span></p>
          )}
          <form action={toggleConnectionStatusAction} className="cx-inline cx-inline--flat">
            <input type="hidden" name="channelId" value={id} /><input type="hidden" name="returnTo" value={back} /><input type="hidden" name="status" value={c.status === 'active' ? 'paused' : 'active'} />
            <SubmitButton className="cx-btn cx-btn--ghost cx-btn--sm" pendingLabel="…">{c.status === 'active' ? 'Pausar el envío' : 'Reactivar el envío'}</SubmitButton>
            <span className="cx-hint">Pausar detiene los envíos; los mensajes que lleguen se siguen guardando.</span>
          </form>
        </section>
      ) : (
        <section className="cx-panel" aria-labelledby="cx-recon">
          <h2 id="cx-recon">Reconectar</h2>
          <p className="cx-hint">Pega un token válido para reactivar este número. Tus conversaciones y mensajes siguen aquí.</p>
          {c.kind === 'whatsapp' ? (
            <form action={saveConnectionTokenAction} className="cx-inline">
              <input type="hidden" name="channelId" value={id} /><input type="hidden" name="returnTo" value={back} />
              <label>Token de acceso<input className="cx-input" name="token" type="password" autoComplete="off" required placeholder="EAAB…" /></label>
              <SubmitButton className="cx-btn cx-btn--primary cx-btn--sm" pendingLabel="Reconectando…">Reconectar y verificar</SubmitButton>
            </form>
          ) : <a className="cx-btn cx-btn--primary" href={oauthStart}>Reconectar con {c.kind === 'gmail' ? 'Google' : 'Meta'}</a>}
        </section>
      )}

      <section className="cx-panel" aria-labelledby="cx-log">
        <h2 id="cx-log">Registro técnico</h2>
        <p className="cx-hint">Solo lo ves tú (administrador). Aquí queda el detalle de lo que pasó, sin credenciales.</p>
        {events.length === 0 ? <p className="cx-muted">Sin eventos todavía.</p> : (
          <ul className="cx-log">
            {events.map((e) => (
              <li key={e.id} className={e.ok ? '' : 'is-bad'}>
                <span className="cx-log-time">{new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short', timeZone: org.orgTimezone }).format(new Date(e.createdAt))}</span>
                <strong>{{ health_check: 'Verificación', token_saved: 'Token guardado', reconnected: 'Reconexión', disconnected: 'Desconexión', connected: 'Conexión', webhook_check: 'Webhook', error: 'Error' }[e.kind] ?? e.kind}</strong>
                {e.code ? <code>{e.code}</code> : null}
                {e.detail ? <span className="cx-muted">{e.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {!disconnected ? (
        <section className="cx-panel cx-panel--danger" aria-labelledby="cx-danger">
          <h2 id="cx-danger">Desconectar esta cuenta</h2>
          <p>Deja de recibir y enviar mensajes y se elimina el acceso guardado. <strong>Las conversaciones y los mensajes se conservan.</strong></p>
          <details className="cx-confirm">
            <summary className="cx-btn cx-btn--danger-ghost">Desconectar…</summary>
            <form action={disconnectConnectionAction}>
              <input type="hidden" name="channelId" value={id} />
              <SubmitButton className="cx-btn cx-btn--danger" pendingLabel="Desconectando…">Sí, desconectar esta cuenta</SubmitButton>
            </form>
          </details>
        </section>
      ) : null}
    </div>
  );
}
