'use client';

import { useActionState, type ReactNode } from 'react';
import { initialActionState } from '@/lib/action-state';
import { addCustomerTagAction, removeCustomerTagAction } from '@/app/(app)/customers/actions';
import type { TagRow } from '@/lib/types';

/** Etiqueta de cliente: mismos 9 colores y misma tabla (`customer_tags`) que ya usa el Inbox; clase propia del sistema de diseño global. */
export function Tag({ tag, children }: { tag: TagRow; children?: ReactNode }) {
  return <span className={`tag tag--${tag.color}`}>{tag.name}{children}</span>;
}

/** Etiquetas de un cliente, con opción de quitarlas (mismo componente en Clientes, Leads e Inbox). */
export function TagList({ tags, customerId, canEdit, existing = [], returnTo }: { tags: TagRow[]; customerId: string; canEdit: boolean; existing?: TagRow[]; returnTo?: string }) {
  const [, formAction] = useActionState(addCustomerTagAction, initialActionState);
  const suggestions = existing.filter((t) => !tags.some((x) => x.id === t.id));
  return (
    <div className="tag-row">
      {tags.length === 0 ? <span className="muted small">Sin etiquetas.</span> : tags.map((t) => (
        <Tag key={t.id} tag={t}>
          {canEdit ? (
            <form action={removeCustomerTagAction} style={{ display: 'inline' }}>
              <input type="hidden" name="customerId" value={customerId} /><input type="hidden" name="tagId" value={t.id} />
              {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
              <button type="submit" className="tag-x" aria-label={`Quitar la etiqueta ${t.name}`}>×</button>
            </form>
          ) : null}
        </Tag>
      ))}
      {canEdit ? (
        <form action={formAction} className="inline-form">
          <input type="hidden" name="customerId" value={customerId} />
          {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
          <label className="sr-only" htmlFor={`tag-add-${customerId}`}>Nueva etiqueta</label>
          <input id={`tag-add-${customerId}`} name="name" list={`tag-opts-${customerId}`} maxLength={40} required placeholder="+ Etiqueta" className="input" style={{ height: 30, width: 130, fontSize: 13 }} autoComplete="off" />
          <datalist id={`tag-opts-${customerId}`}>{suggestions.map((t) => <option key={t.id} value={t.name} />)}</datalist>
        </form>
      ) : null}
    </div>
  );
}
