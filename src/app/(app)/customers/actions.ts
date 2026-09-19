'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession } from '@/lib/session';
import { toUserMessage, UserFacingError } from '@/lib/errors';
import { setFlash } from '@/lib/flash';
import { countryFromLocale } from '@/lib/identity';
import { mergeCustomFields, readCustomFields } from '@/lib/custom-fields';
import type { ActionState } from '@/lib/action-state';
import * as customers from '@/services/customers';
import * as customersRepo from '@/repositories/customers';
import { listFieldDefinitions } from '@/repositories/custom-fields';
import { uuidSchema } from '@/services/schemas';

const str = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v : '');

/** La organización siempre sale de la sesión validada en servidor, nunca del formulario. */
async function ctx() {
  const s = await getSession();
  if (!s?.active) throw new UserFacingError('Tu sesión venció. Inicia sesión de nuevo.');
  return { org: s.active, db: await createClient() };
}
function customerId(fd: FormData) {
  const p = uuidSchema.safeParse(str(fd.get('customerId')));
  if (!p.success) throw new UserFacingError('Cliente no válido.');
  return p.data;
}

export async function createCustomerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let target: string;
  try {
    const { org, db } = await ctx();
    const r = await customers.createCustomer(db, org.orgId, countryFromLocale(org.orgLocale), {
      type: str(fd.get('type')), fullName: str(fd.get('fullName')), phone: str(fd.get('phone')), email: str(fd.get('email')),
      instagram: str(fd.get('instagram')), city: str(fd.get('city')), country: str(fd.get('country')),
      preferredChannel: str(fd.get('preferredChannel')),
    });
    if (r.outcome === 'duplicate_hidden') {
      // Respuesta deliberadamente genérica: no revela quién es la persona propietaria ni sus datos.
      return {
        ok: false,
        error: 'Este contacto ya está registrado y lo atiende otra persona de tu organización. Avisamos a un manager para que lo revise.',
      };
    }
    await setFlash({
      kind: 'ok',
      message: r.outcome === 'existing' ? 'Este contacto ya estaba registrado. Te llevamos a su ficha.' : 'Cliente creado.',
    });
    revalidatePath('/customers');
    target = `/customers/${r.customerId}`;
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
  redirect(target);
}

export async function updateProfileAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await ctx();
    const id = customerId(fd);
    const [current, defs] = await Promise.all([customersRepo.getCustomer(db, id), listFieldDefinitions(db, org.orgId, 'customer')]);
    if (!current) throw new UserFacingError('No encontramos este cliente.');
    const merged = mergeCustomFields(current.customFields, readCustomFields(fd, defs));
    await customers.updateProfile(db, id, {
      fullName: str(fd.get('fullName')), city: str(fd.get('city')), country: str(fd.get('country')),
      address: str(fd.get('address')), preferredChannel: str(fd.get('preferredChannel')), companyId: str(fd.get('companyId')),
    }, merged);
    revalidatePath(`/customers/${id}`);
    revalidatePath('/customers');
    return { ok: true, message: 'Cambios guardados.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function setDoNotContactAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { db } = await ctx();
    const id = customerId(fd);
    const on = str(fd.get('on')) === 'true';
    await customers.setDoNotContact(db, id, on, str(fd.get('reason')));
    revalidatePath(`/customers/${id}`);
    revalidatePath('/customers');
    return { ok: true, message: on ? 'Marcado como «no contactar». Ninguna automatización lo contactará.' : 'Se quitó la marca «no contactar».' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function assignOwnerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { db } = await ctx();
    const id = customerId(fd);
    const owner = str(fd.get('ownerId'));
    await customers.assignOwner(db, id, owner === '' ? null : owner);
    revalidatePath(`/customers/${id}`);
    revalidatePath('/customers');
    return { ok: true, message: 'Asignación actualizada.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function addIdentifierAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const { org, db } = await ctx();
    const id = customerId(fd);
    const outcome = await customers.addIdentifier(db, id, countryFromLocale(org.orgLocale), str(fd.get('type')), str(fd.get('value')));
    revalidatePath(`/customers/${id}`);
    if (outcome === 'conflict') {
      return { ok: false, error: 'Ese dato ya está registrado en otro cliente. Avisamos a un manager para que revise si son la misma persona.' };
    }
    return { ok: true, message: outcome === 'exists' ? 'Ese dato ya estaba en este cliente.' : 'Dato agregado.' };
  } catch (e) {
    return { ok: false, error: toUserMessage(e) };
  }
}

export async function removeIdentifierAction(fd: FormData): Promise<void> {
  const id = str(fd.get('customerId'));
  try {
    const { db } = await ctx();
    const identifierId = uuidSchema.parse(str(fd.get('identifierId')));
    await customersRepo.removeIdentifier(db, identifierId);
    await setFlash({ kind: 'ok', message: 'Dato eliminado.' });
  } catch (e) {
    await setFlash({ kind: 'error', message: toUserMessage(e) });
  }
  revalidatePath(`/customers/${id}`);
  redirect(`/customers/${uuidSchema.safeParse(id).success ? id : ''}`);
}
