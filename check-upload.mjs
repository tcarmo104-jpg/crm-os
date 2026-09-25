// Se ejecuta ANTES de compilar (npm run build → prebuild). Si algo quedó mal subido a GitHub, lo dice en claro y de inmediato,
// en lugar de dejar que la compilación falle con errores de tipos difíciles de entender.
import { existsSync, readdirSync } from 'node:fs';

const REQUIRED = [
  'src/lib/today.ts', 'src/lib/origin.ts', 'src/lib/nav.ts', 'src/lib/reception.ts', 'src/lib/legal.ts',
  'src/server/provider-apps.ts', 'src/server/meta-webhook.ts', 'src/server/origin.ts',
  'src/components/Breadcrumb.tsx', 'src/components/GlobalSearch.tsx', 'src/components/Icon.tsx', 'src/components/icon-shapes.tsx', 'src/components/connections/AppsPanel.tsx',
  'src/app/globals.css', 'src/app/(app)/page.tsx', 'src/app/(app)/loading.tsx', 'src/app/(legal)/privacidad/page.tsx', 'src/app/(legal)/eliminacion-de-datos/page.tsx',
];
const missing = REQUIRED.filter((f) => !existsSync(f));
const stray = readdirSync('.', { withFileTypes: true }).filter((d) => d.isDirectory() && /^crm-os-/i.test(d.name)).map((d) => d.name);

if (stray.length) {
  console.warn(`\n⚠ Hay carpetas subidas por error en la raíz del repositorio: ${stray.join(', ')}\n  Se ignoran en la compilación, pero conviene borrarlas en GitHub (abrir la carpeta → ⋯ → Delete directory).\n`);
}
if (missing.length) {
  console.error('\n' + '='.repeat(72));
  console.error('❌ FALTAN ARCHIVOS EN EL REPOSITORIO: la actualización no se subió completa o quedó en otra carpeta.\n');
  for (const f of missing) console.error('   · ' + f);
  console.error('\n  Causa más común: se subió la carpeta que CONTIENE a «src» y no «src» misma.');
  console.error('  Solución: extrae el ZIP, entra a la carpeta hasta ver «src» y «tsconfig.json», y sube ESO (no la carpeta de afuera).');
  console.error('  Después de subir, GitHub debe mostrar rutas que empiecen con «src/», no con el nombre del ZIP.');
  console.error('='.repeat(72) + '\n');
  process.exit(1);
}
console.log('✔ Chequeo de archivos: todo está en su lugar.');
