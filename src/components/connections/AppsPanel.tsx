import { webhookUrl } from '@/lib/connections';
import { redirectUri } from '@/lib/social';
import { SubmitButton } from '@/components/ui';
import { removeGoogleAppAction, removeMetaAppAction, saveGoogleAppAction, saveMetaAppAction } from '@/app/(app)/settings/connections/actions';

export interface AppState { source: 'app' | 'env' | null; clientId: string | null }

/**
 * «Tu aplicación de Meta / Google»: el Identificador y la Clave secreta se pegan AQUÍ, una sola vez, y el CRM los guarda cifrados y hace el resto
 * (Meta: registra el webhook). Ya no hay que entrar a Vercel. Cada organización puede tener SU propia aplicación.
 */
export function AppsPanel({ meta, google, origin }: { meta: AppState; google: AppState; origin: string }) {
  return (
    <div className="cx-apps">
      <section className={`cx-panel ${meta.source === 'app' ? '' : 'cx-panel--todo'}`} aria-labelledby="cx-app-meta">
        <h2 id="cx-app-meta">Tu aplicación de Meta</h2>
        {meta.source === 'app' ? (
          <p className="cx-app-status"><span className="cx-pill cx-pill--ok"><i aria-hidden="true" />Conectada</span><span>Identificador <code>{meta.clientId}</code></span><span>Tu clave está guardada en el servidor (solo el CRM la lee, nunca se muestra) y el webhook está configurado en Meta.</span></p>
        ) : meta.source === 'env' ? (
          <p className="cx-muted">Se está usando la aplicación de Meta de la plataforma (configurada por quien instaló el sistema). Si tu empresa tiene su propia app de Meta, conéctala aquí y usará la tuya.</p>
        ) : (
          <p><strong>Falta este paso, y es lo que hace llegar tus mensajes.</strong> Pega dos datos de tu app de Meta, una sola vez. El CRM comprueba que sean correctos, los guarda y configura el webhook por ti.</p>
        )}
        <details className="cx-setup" open={meta.source === null}>
          <summary>{meta.source === 'app' ? 'Cambiar las credenciales' : 'Conectar mi aplicación de Meta'}</summary>
          <form action={saveMetaAppAction} className="cx-form">
            <label>Identificador de la app<input className="cx-input" name="appId" inputMode="numeric" required autoComplete="off" placeholder="Ej.: 3431407853702583" /></label>
            <label>Clave secreta de la app<input className="cx-input" name="appSecret" type="password" required autoComplete="off" placeholder="Unas 32 letras y números" /></label>
            <p className="cx-hint">¿Dónde están? En Meta: tu app → <strong>Configuración de la app → Básica</strong>. Copia el «Identificador de la app» y, con el botón <strong>Mostrar</strong>, la «Clave secreta de la app».</p>
            <SubmitButton className="cx-btn cx-btn--primary" pendingLabel="Comprobando con Meta…">Guardar y conectar</SubmitButton>
          </form>
        </details>
        {meta.source === 'app' ? (
          <form action={removeMetaAppAction}><SubmitButton className="cx-btn cx-btn--danger-ghost" pendingLabel="Quitando…">Quitar mi aplicación de Meta</SubmitButton></form>
        ) : null}
        <details className="cx-setup">
          <summary>Direcciones que Meta pide (solo para Facebook e Instagram)</summary>
          <p className="cx-hint">WhatsApp no necesita nada más: el webhook lo registra el CRM. Para iniciar sesión con Facebook/Instagram, agrega esta dirección en Meta → tu app → Inicio de sesión con Facebook → «URI de redireccionamiento de OAuth válidos»:</p>
          <code className="cx-copy">{redirectUri(origin, 'meta')}</code>
          <p className="cx-hint">Dirección del webhook (ya la configura el CRM):</p>
          <code className="cx-copy">{webhookUrl(origin)}</code>
        </details>
      </section>

      <section className={`cx-panel ${google.source === 'app' ? '' : 'cx-panel--todo'}`} aria-labelledby="cx-app-google">
        <h2 id="cx-app-google">Tu aplicación de Google (Gmail)</h2>
        {google.source === 'app' ? (
          <p className="cx-app-status"><span className="cx-pill cx-pill--ok"><i aria-hidden="true" />Conectada</span> ID de cliente <code>{google.clientId}</code>.</p>
        ) : google.source === 'env' ? (
          <p className="cx-muted">Se está usando la aplicación de Google de la plataforma. Si tu empresa tiene su propia app, conéctala aquí.</p>
        ) : (
          <p className="cx-muted">Solo si vas a conectar Gmail: pega el ID de cliente y el secreto de tu app de Google, una sola vez.</p>
        )}
        <details className="cx-setup">
          <summary>{google.source === 'app' ? 'Cambiar las credenciales' : 'Conectar mi aplicación de Google'}</summary>
          <form action={saveGoogleAppAction} className="cx-form">
            <label>ID de cliente<input className="cx-input" name="clientId" required autoComplete="off" placeholder="1234567890-abc.apps.googleusercontent.com" /></label>
            <label>Secreto de cliente<input className="cx-input" name="clientSecret" type="password" required autoComplete="off" placeholder="GOCSPX-…" /></label>
            <p className="cx-hint">En Google Cloud → APIs y servicios → Credenciales → tu «ID de cliente OAuth» (aplicación web). Agrega esta URI de redirección autorizada:</p>
            <code className="cx-copy">{redirectUri(origin, 'google')}</code>
            <SubmitButton className="cx-btn cx-btn--primary" pendingLabel="Comprobando con Google…">Guardar y conectar</SubmitButton>
          </form>
        </details>
        {google.source === 'app' ? (
          <form action={removeGoogleAppAction}><SubmitButton className="cx-btn cx-btn--danger-ghost" pendingLabel="Quitando…">Quitar mi aplicación de Google</SubmitButton></form>
        ) : null}
      </section>
    </div>
  );
}
