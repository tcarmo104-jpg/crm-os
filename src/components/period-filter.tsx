import Link from 'next/link';
import { DATE_PRESET_LABEL, DATE_PRESETS, type DatePreset } from '@/lib/analytics';
import { FilterSelect, DateFilter } from './filters';

/** El mismo selector de período en las 4 pantallas de Analítica: un preset, y fechas si es «Personalizado». */
export function PeriodFilter({ basePath, preset, desde, hasta }: { basePath: string; preset: DatePreset; desde?: string; hasta?: string }) {
  return (
    <>
      <FilterSelect basePath={basePath} param="periodo" label="Período" value={preset === 'this_month' ? '' : preset}
        allLabel={DATE_PRESET_LABEL.this_month} options={DATE_PRESETS.filter((p) => p !== 'this_month').map((p) => ({ value: p, label: DATE_PRESET_LABEL[p] }))} />
      {preset === 'custom' ? (
        <>
          <DateFilter basePath={basePath} param="desde" label="Desde" value={desde ?? ''} />
          <DateFilter basePath={basePath} param="hasta" label="Hasta" value={hasta ?? ''} />
        </>
      ) : null}
    </>
  );
}

/** Enlace «Exportar CSV», visible solo con permiso reports:export. */
export function ExportCsvLink({ type, preset, desde, hasta }: { type: string; preset: DatePreset; desde?: string; hasta?: string }) {
  const qs = new URLSearchParams({ type, periodo: preset });
  if (desde) qs.set('desde', desde);
  if (hasta) qs.set('hasta', hasta);
  return <Link href={`/api/reports/export?${qs}`} className="btn btn-secondary btn-sm">Exportar CSV</Link>;
}
