-- =============================================================================
-- 0028 FOTO DE PERFIL DEL CLIENTE (Facebook e Instagram)
-- =============================================================================
-- WhatsApp no expone la foto de perfil por su API (limitación de Meta, no del CRM): ese canal sigue
-- mostrando solo las iniciales. Facebook e Instagram sí la dan en el mismo llamado que ya se hacía para
-- el nombre del contacto («fillContactName» en el webhook) — se extiende esa función existente en vez de
-- crear un llamado nuevo a la API de Meta.
-- =============================================================================

alter table public.customers add column if not exists avatar_url text check (avatar_url is null or char_length(avatar_url) <= 500);

-- `create or replace` no reemplaza una función si la lista de parámetros cambia: crea otra distinta y las
-- dos quedan ambiguas. Se borra la versión de 2 parámetros antes de crear la de 3.
drop function if exists public.set_contact_profile(uuid, text);

create function public.set_contact_profile(p_conversation uuid, p_name text, p_avatar_url text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  conv public.conversations%rowtype;
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 160), '');
  v_avatar text := nullif(left(btrim(coalesce(p_avatar_url, '')), 500), '');
begin
  select * into conv from public.conversations where id = p_conversation;
  if not found then return; end if;
  if v_name is not null then
    update public.conversations set contact_name = v_name where id = conv.id and contact_name is null;
    update public.customers set full_name = v_name where id = conv.customer_id and full_name ~ '^Contacto de (Facebook|Instagram) [0-9]{4}$';
  end if;
  -- Solo si empieza con https:// hacia Meta: nunca se guarda una URL arbitraria que venga de un campo de texto.
  if v_avatar is not null and v_avatar ~ '^https://[a-zA-Z0-9.-]*\.(fbcdn\.net|cdninstagram\.com|fbsbx\.com)(/|$)' then
    update public.customers set avatar_url = v_avatar where id = conv.customer_id and avatar_url is null;
  end if;
end $$;

-- Mismo llamador de siempre: solo el servidor (service_role), nunca directo desde el navegador.
revoke all on function public.set_contact_profile(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_contact_profile(uuid, text, text) to service_role;
