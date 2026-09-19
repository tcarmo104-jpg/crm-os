'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import type { ActionState } from '@/lib/action-state';
import { updateProduct as repoUpdate } from '@/repositories/products';
import * as commerce from '@/services/commerce';
import { uuidSchema } from '@/services/schemas';

export async function createProductAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    await commerce.createProduct(db, org.orgId, {
      kind: str(fd.get('kind')), sku: str(fd.get('sku')), name: str(fd.get('name')), description: str(fd.get('description')),
      unit: str(fd.get('unit')), unitPrice: str(fd.get('unitPrice')), taxRate: str(fd.get('taxRate')),
    });
    revalidatePath('/products');
    return { ok: true, message: 'Guardado en el catálogo.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function updateProductAction(fd: FormData): Promise<void> {
  try {
    const { db } = await actionContext();
    await commerce.updateProduct(db, uuidSchema.parse(str(fd.get('productId'))), {
      sku: str(fd.get('sku')), name: str(fd.get('name')), description: str(fd.get('description')),
      unit: str(fd.get('unit')), unitPrice: str(fd.get('unitPrice')), taxRate: str(fd.get('taxRate')),
    });
    await setFlash({ kind: 'ok', message: 'Producto actualizado. Las cotizaciones ya hechas conservan el precio con el que se cotizaron.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/products');
  redirect('/products');
}

export async function toggleProductAction(fd: FormData): Promise<void> {
  try {
    const { db } = await actionContext();
    const active = str(fd.get('active')) === 'true';
    await repoUpdate(db, uuidSchema.parse(str(fd.get('productId'))), { active });
    await setFlash({ kind: 'ok', message: active ? 'Producto activado.' : 'Producto desactivado: ya no se ofrece al cotizar.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/products');
  redirect('/products');
}
