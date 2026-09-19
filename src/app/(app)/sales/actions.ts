'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage, UserFacingError } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import * as sales from '@/repositories/sales';
import { uuidSchema } from '@/services/schemas';

async function onSale(fd: FormData, ok: string, run: (db: Awaited<ReturnType<typeof actionContext>>['db'], id: string) => Promise<void>) {
  const id = str(fd.get('saleId'));
  try {
    const { db } = await actionContext();
    await run(db, uuidSchema.parse(id));
    await setFlash({ kind: 'ok', message: ok });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/sales');
  revalidatePath(`/sales/${id}`);
  redirect(`/sales/${uuidSchema.safeParse(id).success ? id : ''}`);
}

export async function deliverSaleAction(fd: FormData) { await onSale(fd, 'Venta marcada como entregada.', (db, id) => sales.markDelivered(db, id)); }
export async function cancelSaleAction(fd: FormData) {
  await onSale(fd, 'Venta anulada. El seguimiento pendiente se canceló.', async (db, id) => {
    const reason = str(fd.get('reason')).trim();
    if (reason.length < 3) throw new UserFacingError('Escribe el motivo de la anulación (al menos 3 letras).');
    await sales.cancelSale(db, id, reason);
  });
}
