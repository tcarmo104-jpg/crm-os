import { describe, expect, it } from 'vitest';
import { describeEvent } from './timeline';
import type { TimelineEvent } from './types';

const ev = (type: string, payload: Record<string, unknown> = {}): TimelineEvent =>
  ({ id: '1', type, occurredAt: '2026-09-19T10:00:00Z', actorId: null, payload });
const name = (id: string | null | undefined) => (id === 'u1' ? 'Ana' : 'Alguien');

describe('describeEvent', () => {
  it('describe los eventos conocidos', () => {
    expect(describeEvent(ev('customer.created', { source: 'csv' }), name).detail).toBe('Origen: Importación CSV');
    expect(describeEvent(ev('customer.assigned', { owner_id: 'u1' }), name).title).toBe('Asignado a Ana');
    expect(describeEvent(ev('customer.assigned', { owner_id: null }), name).title).toBe('Quedó sin asignar');
    expect(describeEvent(ev('lead.created', { source: 'web', campaign: 'verano', resolution: 'matched', do_not_contact: true }), name).detail)
      .toBe('Fuente: Sitio web · Campaña: verano · Ya era cliente · Marcado como no contactar');
  });
  it('un tipo desconocido no rompe: muestra el tipo', () => {
    expect(describeEvent(ev('algo.nuevo'), name)).toEqual({ title: 'algo.nuevo' });
  });
  it('payload con tipos inesperados no lanza errores', () => {
    expect(() => describeEvent(ev('lead.created', { source: 5, campaign: {} }), name)).not.toThrow();
  });

  it('describe oportunidades, leads, tareas y actividades', () => {
    expect(describeEvent(ev('opportunity.stage_changed', { title: 'Plan A', from: 'Nuevo', to: 'Propuesta' }), name))
      .toEqual({ title: 'Oportunidad movida a «Propuesta»', detail: 'Plan A · Desde: Nuevo' });
    expect(describeEvent(ev('opportunity.lost', { title: 'Plan A', reason: 'Precio' }), name).detail).toBe('Plan A · Motivo: Precio');
    expect(describeEvent(ev('lead.status_changed', { from: 'new', to: 'disqualified', reason: 'Sin presupuesto' }), name))
      .toEqual({ title: 'Lead: Nuevo → Descartado', detail: 'Sin presupuesto' });
    expect(describeEvent(ev('task.completed', { title: 'Llamar', outcome: 'Agendó demo' }), name).detail).toBe('Llamar · Resultado: Agendó demo');
    expect(describeEvent(ev('activity.logged', { type: 'call', direction: 'outbound', summary: 'Pidió cotización' }), name))
      .toEqual({ title: 'Llamada (saliente)', detail: 'Pidió cotización' });
  });

  it('describe cotizaciones, ventas y casos', () => {
    expect(describeEvent(ev('quote.accepted', { number: 'COT-0001' }), name)).toEqual({ title: '✔ Cotización aceptada', detail: 'COT-0001' });
    expect(describeEvent(ev('sale.cancelled', { number: 'VTA-0002', reason: 'Desistió' }), name).detail).toBe('VTA-0002 · Motivo: Desistió');
    expect(describeEvent(ev('case.status_changed', { number: 'CAS-0001', to: 'resolved' }), name)).toEqual({ title: 'Caso resuelto', detail: 'CAS-0001' });
    expect(describeEvent(ev('case.opened', { number: 'CAS-0003', title: 'No llegó' }), name).detail).toBe('CAS-0003 · No llegó');
  });

  it('describe las conversaciones de WhatsApp', () => {
    expect(describeEvent(ev('conversation.opened', { channel: 'whatsapp' }), name).title).toBe('Escribió por WhatsApp por primera vez');
    expect(describeEvent(ev('conversation.reopened', {}), name).title).toBe('El cliente volvió a escribir por WhatsApp');
    expect(describeEvent(ev('conversation.opened', { channel: 'gmail' }), name).title).toBe('Escribió por Gmail por primera vez');
    expect(describeEvent(ev('conversation.opened', { channel: 'facebook' }), name).title).toBe('Escribió por Messenger por primera vez');
    expect(describeEvent(ev('conversation.reopened', { channel: 'instagram' }), name).title).toBe('El cliente volvió a escribir por Instagram');
  });
});

