'use client';

import { useActionState } from 'react';
import { initialActionState } from '@/lib/action-state';
import type { ProductRow } from '@/lib/types';
import { SubmitButton } from './ui';
import { Feedback, Field } from './forms';
import { createProductAction } from '@/app/(app)/products/actions';
import { addItemAction, updateHeaderAction } from '@/app/(app)/quotes/actions';
import { openCaseAction } from '@/app/(app)/cases/actions';

export function ProductForm() {
  const [state, formAction] = useActionState(createProductAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <div className="grid-3">
        <div className="field">
          <label className="label" htmlFor="pr-kind">Tipo</label>
          <select id="pr-kind" name="kind" className="select" defaultValue="product">
            <option value="product">Producto</option><option value="service">Servicio</option>
          </select>
        </div>
        <Field id="pr-name" label="Nombre" name="name" maxLength={160} />
        <Field id="pr-sku" label="Código (SKU, opcional)" name="sku" required={false} maxLength={60} />
      </div>
      <div className="grid-3">
        <Field id="pr-price" label="Precio" name="unitPrice" inputMode="decimal" placeholder="150.000" />
        <Field id="pr-tax" label="IVA %" name="taxRate" required={false} inputMode="decimal" placeholder="19" />
        <Field id="pr-unit" label="Unidad" name="unit" required={false} placeholder="unidad, hora, mes…" maxLength={30} />
      </div>
      <Field id="pr-desc" label="Descripción (opcional)" name="description" required={false} maxLength={1000} />
      <div><SubmitButton pendingLabel="Guardando…">Agregar al catálogo</SubmitButton></div>
    </form>
  );
}

export function AddItemForm({ quoteId, products }: { quoteId: string; products: ProductRow[] }) {
  const [state, formAction] = useActionState(addItemAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="quoteId" value={quoteId} />
      {products.length > 0 ? (
        <div className="field">
          <label className="label" htmlFor="ai-product">Producto o servicio del catálogo</label>
          <select id="ai-product" name="productId" className="select" defaultValue="">
            <option value="">— Línea libre (escribe abajo) —</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''} · {p.unitPrice.toLocaleString('es')}</option>)}
          </select>
        </div>
      ) : null}
      <Field id="ai-desc" label="Descripción (solo para línea libre)" name="description" required={false} maxLength={300} />
      <div className="grid-3">
        <Field id="ai-qty" label="Cantidad" name="quantity" required={false} inputMode="decimal" placeholder="1" />
        <Field id="ai-price" label="Precio (déjalo vacío para usar el del catálogo)" name="unitPrice" required={false} inputMode="decimal" />
        <Field id="ai-disc" label="Descuento %" name="discountPct" required={false} inputMode="decimal" placeholder="0" />
      </div>
      <Field id="ai-tax" label="IVA % (vacío = el del producto)" name="taxRate" required={false} inputMode="decimal" />
      <div><SubmitButton className="btn btn-secondary" pendingLabel="Agregando…">Agregar línea</SubmitButton></div>
    </form>
  );
}

export function QuoteHeaderForm({ quoteId, validUntil, notes }: { quoteId: string; validUntil: string | null; notes: string | null }) {
  const [state, formAction] = useActionState(updateHeaderAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <Field id="qh-valid" label="Válida hasta" name="validUntil" type="date" defaultValue={validUntil ?? ''} />
      <div className="field">
        <label className="label" htmlFor="qh-notes">Notas para el cliente</label>
        <textarea id="qh-notes" name="notes" className="input" rows={3} maxLength={2000} defaultValue={notes ?? ''} />
      </div>
      <div><SubmitButton className="btn btn-secondary btn-sm">Guardar</SubmitButton></div>
    </form>
  );
}

export function NewCaseForm({ customerId, sales }: { customerId: string; sales: { id: string; number: string }[] }) {
  const [state, formAction] = useActionState(openCaseAction, initialActionState);
  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      <input type="hidden" name="customerId" value={customerId} />
      <Field id="cs-title" label="¿Qué pasó?" name="title" maxLength={160} placeholder="No llegó el pedido" />
      <div className="grid-3">
        <div className="field">
          <label className="label" htmlFor="cs-kind">Tipo</label>
          <select id="cs-kind" name="kind" className="select" defaultValue="support">
            <option value="support">Soporte</option><option value="complaint">Reclamo</option><option value="warranty">Garantía</option>
            <option value="return">Devolución</option><option value="question">Pregunta</option>
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="cs-priority">Prioridad</label>
          <select id="cs-priority" name="priority" className="select" defaultValue="normal">
            <option value="low">Baja</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option>
          </select>
        </div>
        {sales.length > 0 ? (
          <div className="field">
            <label className="label" htmlFor="cs-sale">Venta relacionada</label>
            <select id="cs-sale" name="saleId" className="select" defaultValue="">
              <option value="">Ninguna</option>
              {sales.map((s) => <option key={s.id} value={s.id}>{s.number}</option>)}
            </select>
          </div>
        ) : null}
      </div>
      <div className="field">
        <label className="label" htmlFor="cs-desc">Detalle (opcional)</label>
        <textarea id="cs-desc" name="description" className="input" rows={3} maxLength={2000} />
      </div>
      <div><SubmitButton pendingLabel="Abriendo…">Abrir caso</SubmitButton></div>
    </form>
  );
}

export function PrintButton() {
  return <button type="button" className="btn btn-secondary btn-sm no-print" onClick={() => window.print()}>Imprimir / guardar como PDF</button>;
}
