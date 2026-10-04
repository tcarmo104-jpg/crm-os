import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { CHANNEL_KINDS, TIME_RE, WEEKDAYS } from '@/lib/assignment-rules';
import * as repo from '@/repositories/assignment-rules';
import { firstIssue } from './schemas';

const schema = z.object({
  name: z.string().trim().min(1, 'Escribe un nombre para la regla.').max(80),
  active: z.boolean(), priority: z.coerce.number().int('La prioridad debe ser un número entero.').min(1).max(9999),
  channelKind: z.preprocess((v) => (v === '' ? null : v), z.enum(CHANNEL_KINDS).nullable()),
  widgetId: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()),
  region: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(80).nullable()),
  teamId: z.string().uuid('Elige un equipo.'),
  hoursStart: z.preprocess((v) => (v === '' ? null : v), z.string().regex(TIME_RE, 'Hora inválida.').nullable()),
  hoursEnd: z.preprocess((v) => (v === '' ? null : v), z.string().regex(TIME_RE, 'Hora inválida.').nullable()),
  hoursDays: z.array(z.coerce.number().int().refine((n) => (WEEKDAYS as readonly number[]).includes(n))).default([1, 2, 3, 4, 5, 6, 7]),
  timezone: z.string().trim().min(1).max(60).default('America/Bogota'),
}).superRefine((d, ctx) => {
  if ((d.hoursStart && !d.hoursEnd) || (!d.hoursStart && d.hoursEnd)) ctx.addIssue({ code: 'custom', message: 'Completa la hora de inicio Y de fin, o deja las dos vacías.' });
  if (d.hoursStart && d.hoursEnd && d.hoursStart >= d.hoursEnd) ctx.addIssue({ code: 'custom', message: 'La hora de inicio debe ser antes que la de fin.' });
  if ((d.hoursStart || d.hoursEnd) && d.hoursDays.length === 0) ctx.addIssue({ code: 'custom', message: 'Elige al menos un día si vas a poner un horario.' });
});

function toInput(d: z.infer<typeof schema>): repo.AssignmentRuleInput {
  return {
    name: d.name, active: d.active, priority: d.priority, channelKind: d.channelKind, widgetId: d.widgetId, region: d.region,
    teamId: d.teamId, hoursStart: d.hoursStart, hoursEnd: d.hoursEnd, hoursDays: (d.hoursDays.length ? d.hoursDays : [1, 2, 3, 4, 5, 6, 7]) as repo.AssignmentRuleInput['hoursDays'],
    timezone: d.timezone,
  };
}

export async function createAssignmentRule(db: ServerSupabase, orgId: string, input: unknown): Promise<string> {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  return repo.createAssignmentRule(db, orgId, toInput(r.data));
}
export async function updateAssignmentRule(db: ServerSupabase, id: string, input: unknown): Promise<void> {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  await repo.updateAssignmentRule(db, id, toInput(r.data));
}
