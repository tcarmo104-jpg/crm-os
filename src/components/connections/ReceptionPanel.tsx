import type { Step, Verdict } from '@/lib/reception';
import { SubmitButton } from '@/components/ui';
import { configureWebhookAction } from '@/app/(app)/settings/connections/actions';

const ICON: Record<Step['status'], string> = { ok: '✔', fail: '✖', warn: '!', todo: '•' };

/**
 * «¿Por qué no llegan mis mensajes?»: una frase con lo que falla, qué hacer, y el detalle paso a paso.
 * Distingue si Meta NO llega, si llega y se RECHAZA, o si llega y no se ve.
 */
export function ReceptionPanel({ verdict, steps, channelId, back, full }: { verdict: Verdict; steps: Step[]; channelId: string; back: string; full: boolean }) {
  return (
    <section className={`cx-panel cx-diag cx-diag--${verdict.kind}`} aria-labelledby="cx-diag">
      <h2 id="cx-diag">{verdict.kind === 'ok' ? 'Recepción de mensajes' : '¿Por qué no llegan mis mensajes?'}</h2>
      <p className="cx-verdict"><strong>{verdict.title}</strong></p>
      <p>{verdict.action}</p>
      <div className="cx-actions">
        {verdict.canAutoConfigure ? (
          <form action={configureWebhookAction}>
            <input type="hidden" name="channelId" value={channelId} /><input type="hidden" name="returnTo" value={`${back}?diag=1`} />
            <SubmitButton className="cx-btn cx-btn--primary" pendingLabel="Configurando en Meta…">Configurar el webhook en Meta automáticamente</SubmitButton>
          </form>
        ) : null}
        <a className="cx-btn cx-btn--secondary" href={`${back}?diag=1`}>{full ? 'Actualizar el diagnóstico' : 'Ejecutar diagnóstico completo'}</a>
      </div>
      <details className="cx-steps-box" open={verdict.kind !== 'ok'}>
        <summary>Ver el detalle paso a paso</summary>
        <ol className="cx-steps">
          {steps.map((s) => (
            <li key={s.key} className={`cx-step cx-step--${s.status}`}>
              <span className="cx-step-ico" aria-hidden="true">{ICON[s.status]}</span>
              <span><strong>{s.title}</strong><small>{s.detail}</small></span>
            </li>
          ))}
        </ol>
        {!full ? <p className="cx-hint">El diagnóstico completo consulta a Meta directamente (tarda unos segundos).</p> : null}
      </details>
    </section>
  );
}
