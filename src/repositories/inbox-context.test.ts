import { describe, expect, it } from 'vitest';
import { aggregateProducts } from './inbox-context';

describe('productos relacionados del cliente', () => {
  it('suma cantidades por nombre, ordena de mayor a menor y limita', () => {
    const r = aggregateProducts([
      { description: 'Silla', quantity: 2 }, { description: 'Mesa', quantity: 1 }, { description: ' Silla ', quantity: 3 }, { description: 'Lámpara', quantity: 5 },
    ]);
    expect(r).toEqual([{ name: 'Lámpara', quantity: 5 }, { name: 'Silla', quantity: 5 }, { name: 'Mesa', quantity: 1 }]);
    expect(aggregateProducts(Array.from({ length: 20 }, (_, i) => ({ description: `P${i}`, quantity: 1 })), 8)).toHaveLength(8);
  });
  it('ignora líneas sin nombre y tolera cantidades como texto', () => {
    expect(aggregateProducts([{ description: '  ', quantity: 4 }, { description: 'X', quantity: '2.5' as unknown as number }])).toEqual([{ name: 'X', quantity: 2.5 }]);
    expect(aggregateProducts([])).toEqual([]);
  });
});
