import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { orderedStages } from '@/lib/pipeline';
import { listPipelines } from '@/repositories/pipelines';
import { ConfirmButton, Notice } from '@/components/ui';
import { AddStageForm, NewPipelineForm } from '@/components/sales-forms';
import { archivePipelineAction, archiveStageAction, moveStageAction, renameStageAction, setDefaultPipelineAction } from './actions';

export const metadata: Metadata = { title: 'Pipelines' };

const KIND = { open: 'Abierta', won: 'Ganada', lost: 'Perdida' } as const;

export default async function PipelinesPage() {
  const session = (await getSession())!;
  const org = session.active!;
  const canManage = can(session, 'pipelines:manage');
  const [pipelines, flash] = await Promise.all([listPipelines(await createClient(), org.orgId), readFlash()]);

  return (
    <>
      <header className="page-head">
        <h1>Pipelines</h1>
        <p className="muted">
          Las etapas por las que pasa una venta. Cada pipeline necesita al menos una etapa abierta, una ganada y una perdida.
          La probabilidad de las etapas abiertas se usa para el valor ponderado del embudo.
        </p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      {canManage ? (
        <section className="panel" aria-labelledby="np"><div className="panel-head"><h2 id="np">Nuevo pipeline</h2></div><NewPipelineForm /></section>
      ) : null}

      {pipelines.map((p) => {
        const stages = orderedStages(p.stages);
        return (
          <section className="panel" key={p.id} aria-labelledby={`p-${p.id}`}>
            <div className="panel-head">
              <h2 id={`p-${p.id}`}>{p.name} {p.isDefault ? <span className="badge badge-ok">Predeterminado</span> : null}</h2>
              {canManage ? (
                <div className="inline-form">
                  {!p.isDefault ? (
                    <>
                      <form action={setDefaultPipelineAction}><input type="hidden" name="pipelineId" value={p.id} /><button className="btn btn-secondary btn-sm" type="submit">Hacer predeterminado</button></form>
                      <form action={archivePipelineAction}><input type="hidden" name="pipelineId" value={p.id} /><ConfirmButton message={`¿Archivar el pipeline «${p.name}»?`} className="btn btn-ghost btn-sm">Archivar</ConfirmButton></form>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div role="list">
              {stages.map((s, i) => (
                <div className="stage-row" role="listitem" key={s.id}>
                  {canManage ? (
                    <form action={renameStageAction} className="inline-form" style={{ display: 'contents' }}>
                      <input type="hidden" name="stageId" value={s.id} /><input type="hidden" name="kind" value={s.kind} />
                      <div>
                        <label className="sr-only" htmlFor={`n-${s.id}`}>Nombre</label>
                        <input id={`n-${s.id}`} name="name" className="input" defaultValue={s.name} maxLength={60} required />
                        <span className="badge">{KIND[s.kind]}</span>
                      </div>
                      {s.kind === 'open' ? (
                        <div><label className="sr-only" htmlFor={`pr-${s.id}`}>Probabilidad</label>
                          <input id={`pr-${s.id}`} name="probability" className="input" defaultValue={s.probability} inputMode="numeric" aria-label="Probabilidad %" /></div>
                      ) : <span className="muted">{s.probability}%</span>}
                      <div className="inline-form">
                        <button className="btn btn-secondary btn-sm" type="submit">Guardar</button>
                      </div>
                    </form>
                  ) : (
                    <><span>{s.name} <span className="badge">{KIND[s.kind]}</span></span><span className="muted">{s.probability}%</span><span /></>
                  )}
                  {canManage ? (
                    <div className="inline-form" style={{ gridColumn: '1 / -1', justifyContent: 'flex-end' }}>
                      <form action={moveStageAction}><input type="hidden" name="stageId" value={s.id} /><input type="hidden" name="dir" value="up" />
                        <button className="btn btn-ghost btn-sm" type="submit" disabled={i === 0 || stages[i - 1]?.kind !== s.kind} aria-label={`Subir ${s.name}`}>↑</button></form>
                      <form action={moveStageAction}><input type="hidden" name="stageId" value={s.id} /><input type="hidden" name="dir" value="down" />
                        <button className="btn btn-ghost btn-sm" type="submit" disabled={i === stages.length - 1 || stages[i + 1]?.kind !== s.kind} aria-label={`Bajar ${s.name}`}>↓</button></form>
                      <form action={archiveStageAction}><input type="hidden" name="stageId" value={s.id} />
                        <ConfirmButton message={`¿Archivar la etapa «${s.name}»?`} className="btn btn-ghost btn-sm">Archivar</ConfirmButton></form>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {canManage ? <AddStageForm pipelineId={p.id} /> : null}
          </section>
        );
      })}
    </>
  );
}
