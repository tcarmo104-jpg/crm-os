/** Utilidades de fechas por zona horaria de la organización (sin librerías externas). */

function parts(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return Object.fromEntries(f.formatToParts(new Date(ts)).map((p) => [p.type, p.value])) as Record<string, string>;
}

/** Diferencia (ms) entre la hora local de `tz` y UTC en el instante `ts`. */
function offsetMs(ts: number, tz: string): number {
  const p = parts(ts, tz);
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * "2026-09-20T09:30" escrito en la zona `tz` → ISO en UTC. Devuelve null si el texto o la zona no son válidos.
 * (Un <input type="datetime-local"> no envía zona: se interpreta en la de la organización, no en la del servidor.)
 */
export function zonedLocalToUtcIso(local: string, tz: string): string | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(asUtc).getUTCMonth() !== mo - 1) return null;   // p. ej. 31 de febrero
  try {
    let ts = asUtc;
    for (let i = 0; i < 2; i++) ts = asUtc - offsetMs(ts, tz);  // 2 pasadas resuelven el cambio de horario
    return new Date(ts).toISOString();
  } catch {
    return null;
  }
}

/** Día calendario (YYYY-MM-DD) de un instante en la zona `tz`. */
export function dayKey(ts: Date | string | number, tz: string): string {
  const p = parts(new Date(ts).getTime(), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Días de calendario entre dos claves YYYY-MM-DD (b - a). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
