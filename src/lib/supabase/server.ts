import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '@/lib/env';

/**
 * Cliente de Supabase con la sesión de la persona usuaria (JWT en cookies).
 * Todas las consultas pasan por RLS: aquí NUNCA se usa la clave service_role.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = publicEnv();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) cookieStore.set(name, value, options);
        } catch {
          // Llamado desde un Server Component: el middleware ya refresca la sesión.
        }
      },
    },
  });
}

export type ServerSupabase = Awaited<ReturnType<typeof createClient>>;
