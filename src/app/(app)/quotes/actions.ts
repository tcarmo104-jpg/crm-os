'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import * as quotes from '@/repositories/quotes';
import * as salesRepo from '@/repositories/sales';
import * as commerce from '@/services/commerce';
import { uuidSchema } from '@/services/schemas';

/** Ejecuta una operación y vuelve a la cotización con un aviso (éxito o error en español). */
async function onQuote(fd: FormData, ok: string, run: (db: Awaited<ReturnType<typeof actionContext>>['db'], id: string) => Promise<string | void>) {
  const id = str(fd.get('quoteId'));
  let target = `/quotes/${uuidSchema.safeParse(id).success ? id : ''}`;
  try {
    const { db } = await actionContext();
    const next = await run(db, uuidSchema.parse(id));
    if (typeof next === 'string') target = next;
    await setFlash({ kind: 'ok', message: ok });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/quotes');
  revalidatePath(target);
  redirect(target);
}

/** Nueva cotización desde una oportunidad. */
export async function createQuoteAction(fd: FormData): Promise<void> {
  const oppId = str(fd.get('opportunityId'));
  let target = `/opportunities/${uuidSchema.safeParse(oppId).success ? oppId : ''}`;
  try {
    const { db } = await actionContext();
    const id = await commerce.createQuote(db, uuidSchema.parse(oppId), { validUntil: str(fd.get('validUntil')), notes: str(fd.get('notes')) });
    await setFlash({ kind: 'ok', message: 'Cotización creada. Agrega las líneas.' });
    target = `/quotes/${id}`;
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/quotes');
  redirect(target);
}

export async function addItemAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { db } = await actionContext();
    const id = uuidSchema.parse(str(fd.get('quoteId')));
    await commerce.addItem(db, id, {
      productId: str(fd.get('productId')), description: str(fd.get('description')), quantity: str(fd.get('quantity')),
      unitPrice: str(fd.get('unitPrice')), discountPct: str(fd.get('discountPct')), taxRate: str(fd.get('taxRate')),
    });
    revalidatePath(`/quotes/${id}`);
    return { ok: true, message: 'Línea agregada.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function updateHeaderAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { db } = await actionContext();
    const id = uuidSchema.parse(str(fd.get('quoteId')));
    await commerce.updateQuoteHeader(db, id, { validUntil: str(fd.get('validUntil')), notes: str(fd.get('notes')) });
    revalidatePath(`/quotes/${id}`);
    return { ok: true, message: 'Guardado.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function updateItemAction(fd: FormData) {
  await onQuote(fd, 'Línea actualizada.', (db) =>
    commerce.updateItem(db, uuidSchema.parse(str(fd.get('itemId'))), {
      quantity: str(fd.get('quantity')), unitPrice: str(fd.get('unitPrice')), discountPct: str(fd.get('discountPct')), description: str(fd.get('description')),
    }));
}
export async function removeItemAction(fd: FormData) {
  await onQuote(fd, 'Línea eliminada.', (db) => quotes.removeItem(db, uuidSchema.parse(str(fd.get('itemId')))));
}
export async function sendQuoteAction(fd: FormData) { await onQuote(fd, 'Cotización enviada. Ya no se puede modificar: si algo cambia, crea una nueva versión.', (db, id) => quotes.sendQuote(db, id)); }
export async function acceptQuoteAction(fd: FormData) { await onQuote(fd, 'Cotización aceptada.', (db, id) => quotes.acceptQuote(db, id)); }
export async function rejectQuoteAction(fd: FormData) { await onQuote(fd, 'Cotización rechazada.', (db, id) => quotes.rejectQuote(db, id, str(fd.get('reason')).trim() || undefined)); }
export async function reviseQuoteAction(fd: FormData) {
  await onQuote(fd, 'Nueva versión creada como borrador.', async (db, id) => `/quotes/${await quotes.reviseQuote(db, id)}`);
}
export async function createSaleAction(fd: FormData) {
  await onQuote(fd, 'Venta registrada. Se abrió el seguimiento postventa y la oportunidad quedó ganada.', async (db, id) => {
    const saleId = await salesRepo.createSale(db, id);
    revalidatePath('/sales');
    revalidatePath('/opportunities');
    return `/sales/${saleId}`;
  });
}
