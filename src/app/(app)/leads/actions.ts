'use server';

import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { toUserMessage, UserFacingError } from '@/lib/errors';
import { countryFromLocale } from '@/lib/identity';
import { decodeCsvBuffer } from '@/lib/csv';
import type { ActionState } from '@/lib/action-state';
import { importLeads } from '@/repositories/leads';
import { listFieldDefinitions } from '@/repositories/custom-fields';
import { importLeadsCsv, MAX_CSV_BYTES } from '@/services/lead-import';
import { revalidatePath } from 'next/cache';

export async function importLeadsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const s = await getSession();
    if (!s?.active) throw new UserFacingError('Tu sesión venció. Inicia sesión de nuevo.');
    const file = fd.get('file');
    if (!(file instanceof File) || file.size === 0) throw new UserFacingError('Selecciona un archivo CSV.');
    if (file.size > MAX_CSV_BYTES) throw new UserFacingError('El archivo pesa más de 2 MB. Divídelo en partes.');

    const text = decodeCsvBuffer(await file.arrayBuffer());
    if (text === null) {
      throw new UserFacingError('Ese archivo no es un CSV. En Excel usa «Guardar como» → «CSV (delimitado por comas)».');
    }

    const db = await createClient();
    const org = s.active;
    const assignToMe = fd.get('assignToMe') === 'on';
    const summary = await importLeadsCsv(text, {
      country: countryFromLocale(org.orgLocale),
      fields: await listFieldDefinitions(db, org.orgId, 'lead'),
      importer: (rows) => importLeads(db, org.orgId, rows, assignToMe),
    });
    revalidatePath('/leads');
    revalidatePath('/customers');
    revalidatePath('/settings/duplicates');
    return { ok: true, data: { summary: JSON.stringify(summary) } };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}
