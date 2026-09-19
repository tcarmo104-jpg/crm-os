/**
 * Interpreta un monto escrito por una persona. Reglas (no adivina más de lo razonable):
 *  - "$", espacios y el código de moneda se ignoran.
 *  - Si hay punto Y coma, el ÚLTIMO es el decimal: "1.500.000,50" y "1,500,000.50" → 1500000.5
 *  - Un solo tipo de separador que se repite es de miles: "1.500.000" → 1500000
 *  - Un separador único seguido de EXACTAMENTE 3 dígitos (y sin "0" delante) es de miles: "1.500" → 1500
 *  - En cualquier otro caso es decimal: "12,5" → 12.5, "0.500" → 0.5
 * Devuelve null si no es un número válido o es negativo.
 */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/[^\d.,-]/g, '');
  if (!s || /-/.test(s.slice(1)) || s.startsWith('-')) return null;
  if (!/\d/.test(s)) return null;

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  let normalized: string;

  if (dots > 0 && commas > 0) {
    const decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thousandsSep = decimalSep === '.' ? ',' : '.';
    if ((s.match(new RegExp(`\\${decimalSep}`, 'g')) ?? []).length > 1) return null;
    normalized = s.split(thousandsSep).join('').replace(decimalSep, '.');
  } else if (dots + commas === 0) {
    normalized = s;
  } else {
    const sep = dots > 0 ? '.' : ',';
    const parts = s.split(sep);
    const last = parts[parts.length - 1] ?? '';
    if (parts.length > 2) {
      normalized = parts.join('');                                   // 1.500.000
    } else if (last.length === 3 && parts[0] !== '0' && parts[0] !== '') {
      normalized = parts.join('');                                   // 1.500
    } else {
      normalized = `${parts[0] || '0'}.${last}`;                     // 12,5 · 0.500
    }
  }
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n * 100) / 100 : null;
}

export function formatMoney(amount: number, currency: string | null | undefined, locale = 'es'): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: currency ?? 'USD', maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString(locale)} ${currency ?? ''}`.trim();
  }
}

/** "19", "19,5", "19.5", "19 %" → número entre 0 y 100 (null si no es válido). */
export function parsePercent(raw: string): number | null {
  const n = Number(raw.replace('%', '').replace(',', '.').trim());
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null;
}

/** Cantidad decimal escrita por una persona ("2", "2,5", "0.333"). No interpreta separadores de miles. */
export function parseQuantity(raw: string): number | null {
  const n = Number(raw.replace(',', '.').trim());
  return raw.trim() !== '' && Number.isFinite(n) && n > 0 && n <= 1_000_000 ? Math.round(n * 1000) / 1000 : null;
}
