import { z } from 'zod';
import { INVITABLE_ROLES } from '@/lib/types';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const organizationSchema = z.object({
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres.').max(120, 'El nombre es demasiado largo.'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/,
      'El identificador debe tener entre 3 y 40 caracteres: letras, números y guiones.',
    ),
});

export const invitationSchema = z.object({
  email: z.string().trim().toLowerCase().email('Ingresa un correo válido.'),
  roleKey: z.enum(INVITABLE_ROLES, { errorMap: () => ({ message: 'Selecciona un rol.' }) }),
  teamId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
});

export const teamSchema = z.object({
  name: z.string().trim().min(1, 'Escribe el nombre del equipo.').max(80, 'El nombre es demasiado largo.'),
  region: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Ingresa tu correo electrónico.').pipe(z.string().email('Ingresa un correo electrónico válido.')),
  password: z.string().min(1, 'Ingresa tu contraseña.'),
});

export const signupSchema = z.object({
  fullName: z.string().trim().min(2, 'Escribe tu nombre.').max(120),
  email: z.string().trim().toLowerCase().email('Ingresa un correo válido.'),
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres.').max(128),
});

export const uuidSchema = z.string().uuid();

export function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? 'Revisa los datos ingresados.';
}
