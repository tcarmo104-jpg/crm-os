'use client';

import { useActionState } from 'react';
import { initialActionState } from '@/lib/action-state';
import { CopyField, SubmitButton } from './ui';
import { Feedback, Field } from './forms';
import { createApiKeyAction } from '@/app/(app)/settings/integrations/actions';

export function ApiKeyForm() {
  const [state, formAction] = useActionState(createApiKeyAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      {state.ok && state.data?.key ? (
        <div className="stack">
          <CopyField label="Tu llave de API" value={state.data.key} />
          <p className="hint"><strong>Cópiala ahora.</strong> Por seguridad solo guardamos una huella: no podremos mostrártela de nuevo.</p>
        </div>
      ) : null}
      <div className="inline-form">
        <Field label="Nombre de la llave" name="name" maxLength={80} placeholder="Sitio web principal" />
        <SubmitButton pendingLabel="Creando…">Crear llave</SubmitButton>
      </div>
    </form>
  );
}
