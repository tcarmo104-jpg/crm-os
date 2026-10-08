import { z } from 'zod';
import type { ServerSupabase } from '@/lib/supabase/server';
import { UserFacingError } from '@/lib/errors';
import { HEX_COLOR, WIDGET_POSITIONS, WIDGET_SIZES, buildBusinessHours, normalizeDomainList, type BusinessHourFormEntry } from '@/lib/widgets';
import * as repo from '@/repositories/widgets';
import { firstIssue } from './schemas';

const businessHourEntrySchema = z.object({ day: z.number().int().min(0).max(6), active: z.boolean(), from: z.string(), to: z.string() });

const schema = z.object({
  channelId: z.string().uuid('Elige un canal de WhatsApp.'),
  name: z.string().trim().min(1, 'Escribe un nombre para el widget.').max(80),
  buttonText: z.string().trim().min(1, 'Escribe el texto del botón.').max(40),
  initialMessage: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(300).optional()),
  position: z.enum(WIDGET_POSITIONS), showText: z.boolean(), color: z.string().regex(HEX_COLOR, 'El color debe ser un código como #25D366.'), size: z.enum(WIDGET_SIZES),
  domains: z.string().trim().min(1, 'Escribe al menos un dominio donde se va a instalar.'),
  // Región de la sede donde se instala; las reglas de distribución la comparan. Opcional: vacía = sin región.
  region: z.preprocess((v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v), z.string().trim().max(80, 'La región puede tener máximo 80 caracteres.').nullable()),
  // Plantilla por defecto del mensaje a WhatsApp (punto 11 del refactor). Vacía = sigue igual que hoy
  // ("Hola, soy {{nombre}}. {{mensaje}}"), armado por `buildPrefilledMessage`.
  messageTemplate: z.preprocess((v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v), z.string().trim().max(1000).nullable()),
  // Horario de atención (Entrega 2). Sin filas activas = sin horario = siempre abierto, igual que antes.
  // Todo opcional (si el llamador no lo manda, es como si no hubiera horario ni asesor configurado).
  businessHours: z.array(businessHourEntrySchema).optional().default([]),
  timezone: z.preprocess((v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? 'America/Bogota' : v), z.string().trim().min(1).max(60)),
  outOfHoursMessage: z.preprocess((v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v), z.string().trim().max(300).nullable()),
  showAdvisor: z.boolean().optional().default(false),
  advisorUserId: z.preprocess((v) => (v === undefined || v === '' ? null : v), z.string().uuid().nullable()).optional(),
});

function toInput(d: z.infer<typeof schema>): repo.WidgetInput {
  const domains = normalizeDomainList(d.domains);
  if (domains.length === 0) throw new UserFacingError('Escribe al menos un dominio válido.');
  return {
    channelId: d.channelId, name: d.name, buttonText: d.buttonText, initialMessage: d.initialMessage ?? null, position: d.position, showText: d.showText,
    color: d.color, size: d.size, allowedDomains: domains, region: d.region, messageTemplate: d.messageTemplate,
    businessHours: buildBusinessHours(d.businessHours as BusinessHourFormEntry[]), timezone: d.timezone, outOfHoursMessage: d.outOfHoursMessage,
    showAdvisor: d.showAdvisor, advisorUserId: d.showAdvisor ? (d.advisorUserId ?? null) : null,
  };
}

export async function createWidget(db: ServerSupabase, orgId: string, input: unknown): Promise<string> {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  return repo.createWidget(db, orgId, toInput(r.data));
}
export async function updateWidget(db: ServerSupabase, id: string, input: unknown): Promise<void> {
  const r = schema.safeParse(input);
  if (!r.success) throw new UserFacingError(firstIssue(r.error));
  await repo.updateWidget(db, id, toInput(r.data));
}
