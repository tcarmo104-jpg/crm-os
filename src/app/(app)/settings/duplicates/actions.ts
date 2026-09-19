'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { toUserMessage } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import { dismissReview, mergeCustomers } from '@/repositories/reviews';
import { uuidSchema } from '@/services/schemas';

const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

export async function mergeAction(fd: FormData): Promise<void> {
  try {
    const keep = uuidSchema.parse(str(fd.get('keepId')));
    const drop = uuidSchema.parse(str(fd.get('dropId')));
    await mergeCustomers(await createClient(), keep, drop);
    await setFlash({ kind: 'ok', message: 'Clientes fusionados. Se conservó el más antiguo y se unieron sus datos, leads y actividad.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/duplicates');
  revalidatePath('/customers');
  redirect('/settings/duplicates');
}

export async function dismissAction(fd: FormData): Promise<void> {
  try {
    await dismissReview(await createClient(), uuidSchema.parse(str(fd.get('reviewId'))));
    await setFlash({ kind: 'ok', message: 'Marcado como revisado.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath('/settings/duplicates');
  redirect('/settings/duplicates');
}
