import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { siteUrl } from '@/lib/env';
import { listApiKeys } from '@/repositories/api-keys';
import { ApiKeyForm } from '@/components/api-key-form';
import { ConfirmButton, Notice } from '@/components/ui';
import { revokeApiKeyAction } from './actions';

export const metadata: Metadata = { title: 'Integraciones' };

export default async function IntegrationsPage() {
  const session = (await getSession())!;
  const org = session.active!;
  if (!can(session, 'integrations:manage')) {
    return (
      <section className="panel">
        <h1>Integraciones</h1>
        <p className="muted">Solo los administradores pueden gestionar integraciones.</p>
      </section>
    );
  }
  const [keys, flash] = await Promise.all([listApiKeys(await createClient(), org.orgId), readFlash()]);
  const fmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: org.orgTimezone });
  const example = `curl -X POST ${siteUrl()}/api/v1/leads \\
  -H "Authorization: Bearer TU_LLAVE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Laura Gómez",
    "phone": "310 111 2233",
    "email": "laura@correo.com",
    "source": "web",
    "campaign": "verano",
    "product_interest": "Plan A",
    "external_id": "form-8841"
  }'`;

  return (
    <>
      <header className="page-head">
        <h1>Integraciones</h1>
        <p className="muted">Recibe leads desde tu sitio web, formularios, Zapier o Make. WhatsApp, Instagram y Facebook llegan en la Fase 5.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <section className="panel" aria-labelledby="new-key">
        <div className="panel-head"><h2 id="new-key">Nueva llave de API</h2></div>
        <ApiKeyForm />
      </section>

      <section className="panel" aria-labelledby="keys-title">
        <div className="panel-head"><h2 id="keys-title">Llaves</h2></div>
        {keys.length === 0 ? <div className="empty"><p><strong>Aún no hay llaves.</strong></p></div> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Nombre</th><th scope="col">Llave</th><th scope="col">Último uso</th><th scope="col">Límite</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name} {k.revokedAt ? <span className="badge badge-danger">Revocada</span> : null}</td>
                    <td><code>{k.keyPrefix}…</code></td>
                    <td>{k.lastUsedAt ? fmt.format(new Date(k.lastUsedAt)) : <span className="muted">Sin usar</span>}</td>
                    <td>{k.rateLimitPerMin}/min</td>
                    <td className="cell-actions">
                      {k.revokedAt ? null : (
                        <form action={revokeApiKeyAction}>
                          <input type="hidden" name="keyId" value={k.id} />
                          <ConfirmButton message="¿Revocar esta llave? Las integraciones que la usen dejarán de funcionar.">Revocar</ConfirmButton>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="doc-title">
        <div className="panel-head"><h2 id="doc-title">Cómo enviar un lead</h2></div>
        <pre className="code-block">{example}</pre>
        <ul>
          <li>Necesitas al menos un dato de contacto: <code>phone</code>, <code>whatsapp</code>, <code>email</code>, <code>instagram</code> o <code>facebook</code>.</li>
          <li>Con <code>external_id</code>, reintentar el mismo envío no duplica el lead (responde 200 en vez de 201).</li>
          <li>Otros campos: <code>name</code>, <code>city</code>, <code>country</code>, <code>channel</code>, <code>ad</code>, <code>form</code>, <code>notes</code>, <code>consent</code> y <code>custom_fields</code> con las claves de <em>Campos personalizados</em>.</li>
          <li>Respuestas: 201/200 correcto · 400/422 datos inválidos · 401 llave inválida · 429 demasiadas solicitudes (cabecera <code>Retry-After</code>).</li>
          <li>Por seguridad la respuesta nunca revela si la persona ya era cliente. Ejecútalo siempre desde tu servidor: no pongas la llave en código de navegador.</li>
        </ul>
      </section>
    </>
  );
}
