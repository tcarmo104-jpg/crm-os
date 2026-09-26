'use client';

import { useActionState, type ReactNode } from 'react';
import Link from 'next/link';
import { initialActionState } from '@/lib/action-state';
import { Feedback, Field } from '@/components/forms';
import { Modal, SubmitButton } from '@/components/ui';
import { createLeadAction } from '@/app/(app)/leads/actions';

/** «Nuevo lead»: crear uno a mano. Al terminar, el modal queda abierto con un enlace al cliente (no se cierra solo). */
export function NewLeadModal({ trigger, sources }: { trigger: ReactNode; sources: string[] }) {
  const [state, formAction] = useActionState(createLeadAction, initialActionState);
  return (
    <Modal title="Nuevo lead" trigger={trigger}>
      {state.ok && state.data ? (
        <div className="stack">
          <Feedback state={state} />
          <p>El teléfono o correo ya identifican a la persona: si ya era cliente, este lead quedó anexado a su ficha.</p>
          <div className="inline-form">
            <Link className="btn btn-primary" href={`/customers/${state.data.customerId}`}>Ver cliente</Link>
            <a className="btn btn-secondary" href="#" onClick={(e) => { e.preventDefault(); window.location.reload(); }}>Crear otro</a>
          </div>
        </div>
      ) : (
        <form action={formAction} className="stack" noValidate>
          <Feedback state={state} />
          <Field label="Nombre" name="name" maxLength={160} placeholder="Nombre completo o de la empresa" />
          <div className="grid-2">
            <div className="field">
              <label className="label" htmlFor="lm-type">Tipo</label>
              <select id="lm-type" name="type" className="select" defaultValue="person">
                <option value="person">Persona</option><option value="company">Empresa</option>
              </select>
            </div>
            <Field label="Fuente" name="source" maxLength={60} placeholder="Feria, referido, web…" list="lm-sources" />
            <datalist id="lm-sources">{sources.map((s) => <option key={s} value={s} />)}</datalist>
          </div>
          <div className="grid-2">
            <Field label="Teléfono" name="phone" required={false} maxLength={30} placeholder="+57 300 000 0000" autoComplete="off" />
            <Field label="Correo" name="email" required={false} type="email" maxLength={160} autoComplete="off" />
          </div>
          <p className="hint">Escribe al menos uno de los dos: es lo que identifica a la persona (y evita crearla dos veces).</p>
          <div className="grid-2">
            <Field label="Canal" name="channel" required={false} maxLength={60} placeholder="WhatsApp, Instagram…" />
            <Field label="Campaña" name="campaign" required={false} maxLength={120} />
          </div>
          <Field label="Producto de interés" name="productInterest" required={false} maxLength={200} />
          <div className="field">
            <label className="label" htmlFor="lm-notes">Notas</label>
            <textarea id="lm-notes" name="notes" className="input" rows={2} maxLength={500} />
          </div>
          <SubmitButton pendingLabel="Creando…">Crear lead</SubmitButton>
        </form>
      )}
    </Modal>
  );
}
