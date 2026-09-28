'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { actionContext, str } from '@/lib/action-context';
import { toUserMessage, UserFacingError } from '@/lib/errors';
import { firstIssue } from '@/services/schemas';
import type { ActionState } from '@/lib/action-state';

const schema = z.object({
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 letras.').max(120),
  timezone: z.string().trim().min(1, 'Elige una zona horaria.'),
  locale: z.string().trim().min(1, 'Elige un idioma y formato.'),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Usa el código de 3 letras de la moneda (por ejemplo, COP, USD).'),
});

export async function updateGeneralSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await actionContext();
    const r = schema.safeParse({ name: str(fd.get('name')), timezone: str(fd.get('timezone')), locale: str(fd.get('locale')), currency: str(fd.get('currency')) });
    if (!r.success) throw new UserFacingError(firstIssue(r.error));
    const { error } = await db.from('organizations').update(r.data).eq('id', org.orgId);
    if (error) throw new UserFacingError('No pudimos guardar los cambios. Inténtalo de nuevo.');
    revalidatePath('/settings/general');
    return { ok: true, message: 'Configuración guardada. Algunos cambios se reflejan al recargar la página.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}
