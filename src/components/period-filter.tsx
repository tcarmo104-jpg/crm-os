import Link from 'next/link';
import type { DatePreset } from '@/lib/analytics';

/** Enlace «Exportar CSV», visible solo con permiso reports:export. */
export function ExportCsvLink({ type, preset, desde, hasta, extra }: { type: string; preset: DatePreset; desde?: string; hasta?: string; extra?: Record<string, string | string[] | undefined> }) {
  const qs = new URLSearchParams({ type, periodo: preset });
  if (desde) qs.set('desde', desde);
  if (hasta) qs.set('hasta', hasta);
  // Filtros adicionales (p. ej. los del widget), para que el CSV sea exactamente lo que se ve en pantalla.
  for (const [k, v] of Object.entries(extra ?? {})) for (const x of Array.isArray(v) ? v : v ? [v] : []) qs.append(k, x);
  return <Link href={`/api/reports/export?${qs}`} className="btn btn-secondary btn-sm">Exportar CSV</Link>;
}
