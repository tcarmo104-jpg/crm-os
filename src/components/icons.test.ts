import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Guardia: todo icono que se pide por nombre existe en el juego único (antes, un nombre inexistente no dibujaba nada y nadie se enteraba). */
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const src = walk('src').filter((f) => /\.(tsx|ts)$/.test(f) && !/\.test\./.test(f));
const keys = (file: string, marker: string) => {
  const t = readFileSync(file, 'utf8'); const a = t.indexOf(marker); const body = t.slice(a, t.indexOf('\n};', a));
  return new Set([...body.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]!));
};
const known = new Set([...keys('src/components/icon-shapes.tsx', 'export const SHAPES'), ...keys('src/components/Icon.tsx', 'export const SHELL_PATHS')]);

describe('iconografía única', () => {
  it('cada <Icon name="x"> / <Ico name="x"> / icon: \'x\' apunta a un icono que existe', () => {
    const used = new Map<string, string[]>();
    for (const f of src) {
      const t = readFileSync(f, 'utf8');
      for (const m of t.matchAll(/<Ico?n?o?\s+name="([a-zA-Z]+)"/g)) used.set(m[1]!, [...(used.get(m[1]!) ?? []), f]);
      if (f.endsWith('lib/nav.ts')) for (const m of t.matchAll(/icon:\s*'([a-zA-Z]+)'/g)) used.set(m[1]!, [...(used.get(m[1]!) ?? []), f]);
    }
    const missing = [...used].filter(([n]) => !known.has(n)).map(([n, fs]) => `${n} (en ${fs[0]})`);
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(20);
  });
  it('los nombres de los dos juegos no se contradicen: hay una sola definición de cada forma compartida', () => {
    const shapes = keys('src/components/icon-shapes.tsx', 'export const SHAPES');
    expect(shapes.size).toBeGreaterThan(20); expect(known.size).toBeGreaterThan(shapes.size);
  });
  it('el peso de trazo es único', () => {
    const t = readFileSync('src/components/icon-shapes.tsx', 'utf8');
    expect(t).toMatch(/export const STROKE = 1\.75/);
    for (const f of ['src/components/Icon.tsx', 'src/components/inbox/icons.tsx']) expect(readFileSync(f, 'utf8')).not.toMatch(/strokeWidth="1\.8"|strokeWidth=\{1\.7\}/);
  });
});
