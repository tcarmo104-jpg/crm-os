import type { ActivityRow, TransitionRow } from './types';

export interface HistoryItem { id: string; at: string; kind: 'stage' | 'activity'; text: string; detail: string | null }

const ACTIVITY_LABEL: Record<string, string> = { call: 'una llamada', whatsapp: 'un mensaje de WhatsApp', email: 'un correo', meeting: 'una reunión', note: 'una nota' };

/**
 * Une los cambios de etapa y las actividades en una sola línea de tiempo (lo más reciente primero).
 * Cada línea dice QUIÉN hizo QUÉ: «Yeison movió la oportunidad de Cotización a Negociación.»
 */
export function buildHistory(transitions: TransitionRow[], activities: ActivityRow[], nameOf: (id: string | null) => string): HistoryItem[] {
  const items: HistoryItem[] = [
    ...transitions.map((t): HistoryItem => {
      const who = t.actorId ? nameOf(t.actorId) : 'El sistema';
      const text = t.fromState === null ? `${who} creó la oportunidad en «${t.toState}».` : `${who} movió la oportunidad de ${t.fromState} a ${t.toState}.`;
      return { id: `t-${t.id}`, at: t.occurredAt, kind: 'stage', text, detail: t.reason ? `Motivo: ${t.reason}` : null };
    }),
    ...activities.map((a): HistoryItem => ({
      id: `a-${a.id}`, at: a.occurredAt, kind: 'activity', text: `${nameOf(a.createdBy)} registró ${ACTIVITY_LABEL[a.type] ?? 'una actividad'}.`, detail: a.summary,
    })),
  ];
  return items.sort((x, y) => y.at.localeCompare(x.at) || y.id.localeCompare(x.id));
}
