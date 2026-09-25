'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useActionState } from 'react';
import { initialActionState } from '@/lib/action-state';
import { ACTIVITY_TYPES, ACTIVITY_TYPE_LABEL, DIRECTIONAL_TYPES, type ActivityType } from '@/lib/activities';
import { Feedback, Field } from '@/components/forms';
import { CloseOnSuccess, Modal, SubmitButton } from '@/components/ui';
import { logActivityAction } from '@/app/(app)/tasks/actions';
import type { Opt, OppOpt } from '@/components/tasks/TaskModals';

/** Registrar una actividad (interacción YA ocurrida): compacto, y sin poder editarse después — un error se corrige con una nota nueva. */
export function NewActivityModal({ trigger, customers, opportunities, defaultCustomerId }: {
  trigger: ReactNode; customers: Opt[]; opportunities: OppOpt[]; defaultCustomerId?: string;
}) {
  const [state, formAction] = useActionState(logActivityAction, initialActionState);
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? customers[0]?.id ?? '');
  const [type, setType] = useState<ActivityType>('call');
  const oppOptions = useMemo(() => opportunities.filter((o) => o.customerId === customerId), [opportunities, customerId]);
  const needsDirection = DIRECTIONAL_TYPES.includes(type);
  return (
    <Modal title="Registrar actividad" trigger={trigger}>
      <form action={formAction} className="stack" noValidate>
        <Feedback state={state} />
        <CloseOnSuccess ok={state.ok} />
        <div className="field">
          <label className="label" htmlFor="am-customer">Cliente</label>
          <select id="am-customer" name="customerId" className="select" value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
            <option value="" disabled>Elige un cliente</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="grid-2">
          <div className="field">
            <label className="label" htmlFor="am-type">Tipo</label>
            <select id="am-type" name="type" className="select" value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
              {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{ACTIVITY_TYPE_LABEL[t]}</option>)}
            </select>
          </div>
          {needsDirection ? (
            <div className="field">
              <label className="label" htmlFor="am-dir">Dirección</label>
              <select id="am-dir" name="direction" className="select" defaultValue="outbound">
                <option value="outbound">Saliente</option>
                <option value="inbound">Entrante</option>
              </select>
            </div>
          ) : (
            <Field label="Fecha y hora" name="occurredAt" type="datetime-local" required={false} />
          )}
        </div>
        {needsDirection ? <Field label="Fecha y hora" name="occurredAt" type="datetime-local" required={false} /> : null}
        {oppOptions.length > 0 ? (
          <div className="field">
            <label className="label" htmlFor="am-opp">Oportunidad relacionada</label>
            <select id="am-opp" name="opportunityId" className="select" defaultValue="">
              <option value="">Sin oportunidad</option>
              {oppOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label className="label" htmlFor="am-summary">¿Qué pasó?</label>
          <textarea id="am-summary" name="summary" className="input" rows={4} maxLength={2000} required />
        </div>
        <p className="hint">Las actividades no se editan: si te equivocas, agrega una nota nueva.</p>
        <SubmitButton pendingLabel="Guardando…">Registrar</SubmitButton>
      </form>
    </Modal>
  );
}
