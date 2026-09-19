import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * Cliente con la clave service_role: OMITE RLS.
 * Solo para procesos de fondo en el servidor. Jamás importar desde componentes ni acciones de usuario.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
