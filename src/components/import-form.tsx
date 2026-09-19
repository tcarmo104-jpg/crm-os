'use client';

import { useActionState } from 'react';
import { initialActionState } from '@/lib/action-state';
import type { ImportSummary } from '@/services/lead-import';
import { Notice, SubmitButton } from './ui';
import { importLeadsAction } from '@/app/(app)/leads/actions';

export function ImportForm({ canAssign }: { canAssign: boolean }) {
  const [state, formAction] = useActionState(importLeadsAction, initialActionState);
  const summary: ImportSummary | null = state.ok && state.data?.summary ? (JSON.parse(state.data.summary) as ImportSummary) : null;

  return (
    <div className="stack">
      <form action={formAction} className="stack">
        {state.error ? <Notice kind="error">{state.error}</Notice> : null}
        <div className="field">
          <label className="label" htmlFor="f-file">Archivo CSV</label>
          <input id="f-file" name="file" type="file" accept=".csv,text/csv,text/plain" className="input" required />
        </div>
        {canAssign ? (
          <label className="inline-form"><input type="checkbox" name="assignToMe" /> Asignarme los clientes nuevos (si no, quedan sin asignar para que un manager los reparta)</label>
        ) : (
          <p className="hint">Los clientes nuevos quedarán asignados a ti.</p>
        )}
        <div><SubmitButton pendingLabel="Importando…">Importar</SubmitButton></div>
      </form>

      {summary ? (
        <div className="stack" role="status">
          <Notice kind={summary.failed === 0 ? 'ok' : 'error'}>
            Se procesaron {summary.total} filas: {summary.created} clientes nuevos, {summary.matched} ya existían, {summary.failed} con error.
          </Notice>
          {summary.review > 0 || summary.conflict > 0 ? (
            <p className="muted small">
              {summary.review + summary.conflict} filas quedaron en revisión por posible duplicado: un manager puede revisarlas en Configuración → Duplicados.
            </p>
          ) : null}
          {summary.warnings > 0 ? <p className="muted small">{summary.warnings} filas tenían un dato de contacto inválido que se omitió (se importó con los demás datos).</p> : null}
          {summary.ignoredColumns.length > 0 ? <p className="muted small">Columnas ignoradas (no reconocidas): {summary.ignoredColumns.join(', ')}.</p> : null}
          {summary.errors.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Fila</th><th scope="col">Problema</th></tr></thead>
                <tbody>{summary.errors.map((e) => <tr key={e.line}><td>{e.line}</td><td>{e.message}</td></tr>)}</tbody>
              </table>
              {summary.failed > summary.errors.length ? <p className="muted small">Mostrando los primeros {summary.errors.length} errores.</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
