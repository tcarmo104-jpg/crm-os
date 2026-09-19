import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listFieldDefinitions } from '@/repositories/custom-fields';
import { FIELD_TYPE_LABELS } from '@/lib/custom-fields';
import { FieldForm } from '@/components/field-form';
import { Notice } from '@/components/ui';
import { archiveFieldAction } from './actions';

export const metadata: Metadata = { title: 'Campos personalizados' };

export default async function FieldsPage() {
  const session = (await getSession())!;
  const org = session.active!;
  const canManage = can(session, 'fields:manage');
  const [defs, flash] = await Promise.all([listFieldDefinitions(await createClient(), org.orgId), readFlash()]);
  const entityLabel = { customer: 'Clientes', lead: 'Leads', opportunity: 'Oportunidades' } as const;

  return (
    <>
      <header className="page-head">
        <h1>Campos personalizados</h1>
        <p className="muted">
          Agrega los datos propios de tu negocio. Se validan al guardar (tipo, opciones, formato), vengan de un formulario, un CSV o la API.
        </p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      {canManage ? (
        <section className="panel" aria-labelledby="new-field">
          <div className="panel-head"><h2 id="new-field">Nuevo campo</h2></div>
          <FieldForm />
        </section>
      ) : null}

      <section className="panel" aria-labelledby="fields-title">
        <div className="panel-head"><h2 id="fields-title">Campos de la organización</h2></div>
        {defs.length === 0 ? (
          <div className="empty"><p><strong>Aún no hay campos personalizados.</strong></p></div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Nombre</th><th scope="col">Se usa en</th><th scope="col">Tipo</th>
                  <th scope="col">Clave (API / CSV)</th>{canManage ? <th scope="col"><span className="sr-only">Acciones</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {defs.map((d) => (
                  <tr key={d.id}>
                    <td>{d.label} {d.archivedAt ? <span className="badge">Archivado</span> : null}
                      {d.options.length > 0 ? <div className="small muted">{d.options.join(' · ')}</div> : null}</td>
                    <td>{entityLabel[d.entity]}</td>
                    <td>{FIELD_TYPE_LABELS[d.type]}</td>
                    <td><code>{d.key}</code></td>
                    {canManage ? (
                      <td className="cell-actions">
                        <form action={archiveFieldAction}>
                          <input type="hidden" name="fieldId" value={d.id} />
                          <input type="hidden" name="archive" value={d.archivedAt ? 'false' : 'true'} />
                          <button className="btn btn-ghost btn-sm" type="submit">{d.archivedAt ? 'Restaurar' : 'Archivar'}</button>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
