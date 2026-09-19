/**
 * Variables públicas: se leen con acceso literal para que Next las inserte en el build.
 * Se validan al usarlas (no al importar) para no romper el build sin variables.
 */
export function publicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY. Copia .env.example a .env.local y complétalas.',
    );
  }
  return { url, anonKey };
}

export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}
