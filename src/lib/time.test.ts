import { describe, expect, it } from 'vitest';
import { dayKey, daysBetween, zonedLocalToUtcIso } from './time';

describe('zonedLocalToUtcIso', () => {
  it('Bogotá es UTC-5 todo el año', () => {
    expect(zonedLocalToUtcIso('2026-09-20T09:30', 'America/Bogota')).toBe('2026-09-20T14:30:00.000Z');
    expect(zonedLocalToUtcIso('2026-01-05T00:00', 'America/Bogota')).toBe('2026-01-05T05:00:00.000Z');
  });
  it('respeta el horario de verano (Nueva York)', () => {
    expect(zonedLocalToUtcIso('2026-07-01T12:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z');   // UTC-4
    expect(zonedLocalToUtcIso('2026-12-01T12:00', 'America/New_York')).toBe('2026-12-01T17:00:00.000Z');   // UTC-5
  });
  it('zonas con desfase positivo (Madrid en invierno UTC+1)', () => {
    expect(zonedLocalToUtcIso('2026-12-01T08:00', 'Europe/Madrid')).toBe('2026-12-01T07:00:00.000Z');
  });
  it('rechaza formatos, fechas imposibles y zonas inválidas', () => {
    expect(zonedLocalToUtcIso('20/09/2026 09:30', 'America/Bogota')).toBeNull();
    expect(zonedLocalToUtcIso('2026-02-31T10:00', 'America/Bogota')).toBeNull();
    expect(zonedLocalToUtcIso('2026-09-20T09:30', 'Mars/Olympus')).toBeNull();
  });
});

describe('dayKey / daysBetween', () => {
  it('el día depende de la zona: 02:00 UTC ya es "ayer" en Bogotá', () => {
    const t = '2026-09-20T02:00:00Z';
    expect(dayKey(t, 'UTC')).toBe('2026-09-20');
    expect(dayKey(t, 'America/Bogota')).toBe('2026-09-19');
  });
  it('días de calendario, también entre meses y años', () => {
    expect(daysBetween('2026-09-19', '2026-09-20')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-02')).toBe(2);
    expect(daysBetween('2026-09-20', '2026-09-19')).toBe(-1);
  });
});
