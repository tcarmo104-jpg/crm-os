import { describe, expect, it } from 'vitest';
import { ACTIVITY_TYPES, ACTIVITY_TYPE_ICON, ACTIVITY_TYPE_LABEL, dayHeading, DIRECTIONAL_TYPES, groupActivitiesByDay } from './activities';

const TZ = 'America/Bogota';
const NOW = new Date('2026-09-19T15:00:00Z'); // 10:00 en Bogotá

describe('catálogo de tipos de actividad', () => {
  it('todo tipo tiene etiqueta e icono, incluida la nueva «Visita»', () => {
    for (const t of ACTIVITY_TYPES) { expect(ACTIVITY_TYPE_LABEL[t]).toBeTruthy(); expect(ACTIVITY_TYPE_ICON[t]).toBeTruthy(); }
    expect(ACTIVITY_TYPE_LABEL.visit).toBe('Visita');
  });
  it('solo llamada, WhatsApp y correo tienen dirección (entrante/saliente)', () => {
    expect(DIRECTIONAL_TYPES).toEqual(['call', 'whatsapp', 'email']);
    expect(DIRECTIONAL_TYPES).not.toContain('visit'); expect(DIRECTIONAL_TYPES).not.toContain('meeting'); expect(DIRECTIONAL_TYPES).not.toContain('note');
  });
});

describe('encabezado del día', () => {
  it('Hoy, Ayer, o la fecha (zona de la organización)', () => {
    expect(dayHeading('2026-09-19T20:00:00Z', NOW, TZ)).toBe('Hoy');       // 15:00 hoy en Bogotá
    expect(dayHeading('2026-09-19T02:00:00Z', NOW, TZ)).toBe('Ayer');      // 21:00 de ayer en Bogotá
    expect(dayHeading('2026-09-10T15:00:00Z', NOW, TZ)).toMatch(/10 de septiembre/);
  });
});

describe('agrupar por día', () => {
  it('agrupa consecutivos del mismo día y conserva el orden ya dado (más reciente primero)', () => {
    const a = (id: string, occurredAt: string) => ({ id, occurredAt });
    const g = groupActivitiesByDay([a('1', '2026-09-19T20:00:00Z'), a('2', '2026-09-19T14:00:00Z'), a('3', '2026-09-18T14:00:00Z')], NOW, TZ);
    expect(g.map((x) => x.heading)).toEqual(['Hoy', 'Ayer']);
    expect(g[0]!.items.map((x) => x.id)).toEqual(['1', '2']);
    expect(g[1]!.items.map((x) => x.id)).toEqual(['3']);
  });
  it('sin actividades no hay grupos', () => expect(groupActivitiesByDay([], NOW, TZ)).toEqual([]));
});
