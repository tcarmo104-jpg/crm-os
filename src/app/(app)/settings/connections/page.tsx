import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PROVIDERS, stateInfo, timeAgo, webhookUrl, type ProviderKey } from '@/lib/connections';
import { siteUrl } from '@/lib/env';
import { encryptionEnabled } from '@/lib/secrets';
import { readFlash } from '@/lib/flash';
import { redirectUri } from '@/lib/social';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import type { ChannelRow } from '@/lib/types';
import { listChannels } from '@/repositories/inbox';
import { InboxFeed, KV, Logo, Row, StatusPill } from '@/components/connections/parts';
import { Notice, SubmitButton } from '@/components/ui';
import { connectWhatsAppAction, disconnectConnectionAction, syncGmailAction, verifyConnectionAction } from './actions';
import './connections.css';

export const metadata: Metadata = { title: 'Conexiones' };
const env = (k: string) => Boolean(process.env[k]?.trim());

const subtitle = (c: ChannelRow) => (c.kind === 'gmail' ? c.externalId : c.kind === 'facebook' ? `Página · ID ${c.externalId}` : c.kind === 'instagram' ? `Cuenta · ID ${c.externalId}` : c.displayPhone ?? `ID ${c.externalId}`);
const titleOf = (c: ChannelRow) => (c.kind === 'gmail' ? c.externalId : c.accountName ?? c.name);

export default async function ConnectionsPage() {
  const session = (await getSession())!;
  if (!can(session, 'settings:manage')) redirect('/inbox');
  const org = session.active!;
  const db = await createClient();
  const [channels, flash] = await Promise.all([listChannels(db, org.orgId), readFlash()]);
  const isLive = (c: ChannelRow) => c.connectionStatus === 'connected' && c.status === 'active';
  const liveCount = channels.filter(isLive).length;
  const metaOk = env('META_APP_ID') && env('META_APP_SECRET');
  const googleOk = env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET');
  const webhookOk = env('META_APP_SECRET') && env('META_VERIFY_TOKEN');
  const now = new Date();
  const site = siteUrl();

  const setup = (key: ProviderKey) => (
    <details className="cx-setup">
      <summary>Datos para configurar {key === 'gmail' ? 'Google' : 'Meta'}</summary>
      {key === 'whatsapp' || key === 'facebook' || key === 'instagram' ? (
        <KV>
          <Row k="URL del webhook"><code className="cx-copy">{webhookUrl(site) ?? 'Define NEXT_PUBLIC_SITE_URL'}</code></Row>
          <Row k="Token de verificación">{env('META_VERIFY_TOKEN') ? <span className="cx-pill cx-pill--ok"><i aria-hidden="true" />Configurado en el servidor</span> : <span className="cx-pill cx-pill--danger"><i aria-hidden="true" />Falta META_VERIFY_TOKEN</span>}</Row>
          <Row k="App Secret">{env('META_APP_SECRET') ? <span className="cx-pill cx-pill--ok"><i aria-hidden="true" />Configurado en el servidor</span> : <span className="cx-pill cx-pill--danger"><i aria-hidden="true" />Falta META_APP_SECRET</span>}</Row>
          {key !== 'whatsapp' ? <Row k="URI de redirección de OAuth"><code className="cx-copy">{redirectUri(site, 'meta')}</code></Row> : null}
          {key !== 'whatsapp' ? <Row k="ID de la app (META_APP_ID)">{env('META_APP_ID') ? <span className="cx-pill cx-pill--ok"><i aria-hidden="true" />Configurado</span> : <span className="cx-pill cx-pill--danger"><i aria-hidden="true" />Falta META_APP_ID</span>}</Row> : null}
        </KV>
      ) : (
        <KV>
          <Row k="URI de redirección autorizada"><code className="cx-copy">{redirectUri(site, 'google')}</code></Row>
          <Row k="Credenciales de Google">{googleOk ? <span className="cx-pill cx-pill--ok"><i aria-hidden="true" />Configuradas en el servidor</span> : <span className="cx-pill cx-pill--danger"><i aria-hidden="true" />Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET</span>}</Row>
        </KV>
      )}
      {key === 'facebook' || key === 'instagram' ? <ol><li>En tu app de Meta → Webhooks, pega la URL y el token de verificación.</li><li>Producto «Page»: suscribe <code>messages</code>, <code>messaging_postbacks</code>, <code>message_deliveries</code> y <code>message_reads</code>.</li><li>Producto «Instagram»: suscribe <code>messages</code>.</li><li>En «Inicio de sesión con Facebook» agrega la URI de redirección de arriba.</li></ol> : null}
      {key === 'gmail' ? <ol><li>En Google Cloud: habilita la <strong>Gmail API</strong> y crea credenciales «ID de cliente OAuth» (aplicación web).</li><li>Agrega la URI de redirección de arriba.</li><li>Permisos: leer y enviar correo de Gmail. Mientras la app esté en modo de prueba, agrega tu correo como usuario de prueba.</li></ol> : null}
    </details>
  );

  return (
    <div className="cx">
      <header className="cx-head">
        <div>
          <h1>Conexiones</h1>
          <p className="cx-muted">Conecta tus canales de comunicación. Cada conexión activa alimenta el Inbox del CRM, y cada conversación queda asociada a su cliente.</p>
        </div>
        <Link href="/inbox" className="cx-btn cx-btn--ghost">Ir al Inbox</Link>
      </header>

      <ol className="cx-flow" aria-label="Cómo llegan los mensajes al CRM">
        <li><strong>Canal conectado</strong><span>WhatsApp, Instagram, Facebook, Gmail</span></li>
        <li aria-hidden="true" className="cx-flow-arrow">→</li>
        <li><strong>Inbox único</strong><span>{liveCount > 0 ? `${liveCount} ${liveCount === 1 ? 'conexión activa' : 'conexiones activas'}` : 'Aún sin conexiones activas'}</span></li>
        <li aria-hidden="true" className="cx-flow-arrow">→</li>
        <li><strong>Cliente</strong><span>La conversación se asocia sola al contacto</span></li>
        <li aria-hidden="true" className="cx-flow-arrow">→</li>
        <li><strong>Oportunidades y ventas</strong><span>Sin duplicar leads</span></li>
      </ol>

      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}
      {!webhookOk ? <Notice kind="error">Falta configurar en el servidor: {['META_APP_SECRET', 'META_VERIFY_TOKEN'].filter((k) => !env(k)).join(', ')}. Sin esas variables los mensajes de WhatsApp, Messenger e Instagram no llegan. Mira la guía docs/META-WHATSAPP.md.</Notice> : null}
      {!encryptionEnabled() ? <p className="cx-hint">Los tokens se guardan protegidos por el acceso a la base de datos. Para cifrarlos además, define <code>CONNECTIONS_ENCRYPTION_KEY</code> en el servidor (opcional).</p> : null}

      <div className="cx-grid">
        {PROVIDERS.map((p) => {
          const accounts = channels.filter((c) => c.kind === p.key);
          const oauthReady = p.key === 'gmail' ? googleOk : metaOk;
          return (
            <section key={p.key} className="cx-card" aria-labelledby={`cx-${p.key}`}>
              <header className="cx-card-head">
                <Logo provider={p.key} />
                <div>
                  <h2 id={`cx-${p.key}`}>{p.key === 'facebook' ? 'Facebook Messenger' : p.key === 'instagram' ? 'Instagram Direct' : p.name}</h2>
                  <InboxFeed live={accounts.some(isLive)} />
                </div>
              </header>
              <p className="cx-muted cx-blurb">{p.blurb}</p>

              {accounts.length === 0 ? <p className="cx-empty">Todavía no hay {p.key === 'whatsapp' ? 'un número' : p.key === 'facebook' ? 'una página' : p.key === 'instagram' ? 'una cuenta' : 'un correo'} conectad{p.key === 'whatsapp' || p.key === 'gmail' ? 'o' : 'a'}.</p> : (
                <ul className="cx-accounts">
                  {accounts.map((c) => {
                    const info = stateInfo(c.connectionStatus);
                    return (
                      <li key={c.id} className="cx-account">
                        <div className="cx-account-top">
                          <div><strong>{titleOf(c)}</strong><span className="cx-muted"> · {subtitle(c)}</span></div>
                          <StatusPill state={c.connectionStatus} />
                        </div>
                        {info.needsAction ? <p className="cx-alert">{info.message(p.name)}</p> : null}
                        {c.status === 'paused' ? <p className="cx-alert cx-alert--warn">En pausa: no envía mensajes.</p> : null}
                        <p className="cx-meta">Última sincronización: <strong>{timeAgo(c.lastSyncAt, now)}</strong>{c.lastWebhookAt ? <> · {c.kind === 'gmail' ? 'Último correo' : 'Último mensaje'} recibido: <strong>{timeAgo(c.lastWebhookAt, now)}</strong></> : null}</p>
                        <div className="cx-actions">
                          <Link className="cx-btn cx-btn--primary cx-btn--sm" href={`/settings/connections/${c.kind}/${c.id}`}>Configurar</Link>
                          {c.connectionStatus !== 'disconnected' ? (
                            <form action={verifyConnectionAction}><input type="hidden" name="channelId" value={c.id} /><SubmitButton className="cx-btn cx-btn--secondary cx-btn--sm" pendingLabel="Verificando…">Verificar</SubmitButton></form>
                          ) : null}
                          {c.kind === 'gmail' && c.connectionStatus !== 'disconnected' ? (
                            <form action={syncGmailAction}><input type="hidden" name="channelId" value={c.id} /><SubmitButton className="cx-btn cx-btn--secondary cx-btn--sm" pendingLabel="Sincronizando…">Sincronizar</SubmitButton></form>
                          ) : null}
                          {c.connectionStatus !== 'disconnected' ? (
                            <details className="cx-confirm">
                              <summary className="cx-btn cx-btn--danger-ghost cx-btn--sm">Desconectar</summary>
                              <form action={disconnectConnectionAction}>
                                <p>Esta cuenta dejará de recibir y enviar mensajes. <strong>Tu historial se conserva.</strong> Podrás reconectarla cuando quieras.</p>
                                <input type="hidden" name="channelId" value={c.id} />
                                <SubmitButton className="cx-btn cx-btn--danger cx-btn--sm" pendingLabel="Desconectando…">Sí, desconectar</SubmitButton>
                              </form>
                            </details>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {p.key === 'whatsapp' ? (
                <details className="cx-new" open={accounts.length === 0}>
                  <summary className="cx-btn cx-btn--secondary">+ {accounts.length === 0 ? 'Conectar un número' : 'Conectar otro número'}</summary>
                  <form action={connectWhatsAppAction} className="cx-form">
                    <p className="cx-hint">Estos datos salen de Meta → tu app → WhatsApp → «Configuración de la API». Comprobamos con Meta que sean correctos <strong>antes</strong> de guardar nada.</p>
                    <label>Nombre para reconocerlo (opcional)<input className="cx-input" name="name" maxLength={80} placeholder="Ej.: Ventas Medellín" /></label>
                    <label>ID del número de teléfono<input className="cx-input" name="phoneNumberId" inputMode="numeric" required placeholder="Ej.: 109876543210987" /></label>
                    <label>ID de la cuenta de WhatsApp Business<input className="cx-input" name="businessAccountId" inputMode="numeric" required placeholder="Ej.: 123456789012345" /></label>
                    <label>Token de acceso permanente<input className="cx-input" name="token" type="password" autoComplete="off" required placeholder="EAAB…" /></label>
                    <p className="cx-hint">El token nunca se muestra después de guardarlo. Necesita los permisos <code>whatsapp_business_messaging</code> y <code>whatsapp_business_management</code>.</p>
                    <SubmitButton className="cx-btn cx-btn--primary" pendingLabel="Verificando con Meta…">Conectar y verificar</SubmitButton>
                  </form>
                </details>
              ) : (
                <div className="cx-soon">
                  {oauthReady ? (
                    <a className="cx-btn cx-btn--primary" href={p.key === 'gmail' ? '/api/connections/google/start' : '/api/connections/meta/start'}>
                      {p.key === 'gmail' ? (accounts.length ? 'Conectar otra cuenta de Google' : 'Conectar con Google') : accounts.length ? 'Conectar más páginas con Meta' : `Conectar ${p.name} con Meta`}
                    </a>
                  ) : (
                    <><button type="button" className="cx-btn cx-btn--secondary" disabled>{p.key === 'gmail' ? 'Conectar con Google' : 'Conectar con Meta'}</button>
                      <p className="cx-alert cx-alert--warn">{p.key === 'gmail' ? 'Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el servidor.' : 'Faltan META_APP_ID y META_APP_SECRET en el servidor.'}</p></>
                  )}
                  <p className="cx-hint">{p.key === 'gmail' ? 'Inicias sesión con Google y autorizas leer y responder correos. Nunca guardamos tu contraseña.' : 'Con un solo inicio de sesión eliges tus páginas de Facebook y las cuentas de Instagram asociadas. Solo pedimos los permisos necesarios.'}</p>
                </div>
              )}
              {setup(p.key)}
            </section>
          );
        })}
      </div>
      <p className="cx-hint">Las plantillas de mensajes de WhatsApp siguen en <Link href="/settings/channels">Configuración → Canales (WhatsApp)</Link>.</p>
    </div>
  );
}
