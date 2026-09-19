import { describe, expect, it } from 'vitest';
import { canConvert, nextLeadStatuses, needsReason } from './leads';

describe('máquina de estados de leads (espejo de la BD)', () => {
  it('transiciones permitidas', () => {
    expect(nextLeadStatuses('new')).toEqual(['contacted', 'qualified', 'disqualified']);
    expect(nextLeadStatuses('disqualified')).toEqual(['new']);
    expect(nextLeadStatuses('converted')).toEqual([]);
    expect(nextLeadStatuses('desconocido')).toEqual([]);
  });
  it('convertir solo desde estados abiertos, y descartar exige motivo', () => {
    expect(canConvert('new')).toBe(true);
    expect(canConvert('qualified')).toBe(true);
    expect(canConvert('converted')).toBe(false);
    expect(canConvert('disqualified')).toBe(false);
    expect(needsReason('disqualified')).toBe(true);
    expect(needsReason('contacted')).toBe(false);
  });
});
