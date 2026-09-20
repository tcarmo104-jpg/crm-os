-- Pruebas de 0022: credenciales de la aplicación de Meta/Google dentro del CRM.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-c101-0000-0000-00000000000a'''
\set B  '''bbbbbbbb-c101-0000-0000-00000000000b'''
\set S1 '''51000000-c101-0000-0000-000000000001'''
\set SEC '''a1b2c3d4e5f60718293a4b5c6d7e8f90'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@pa.test'), (:B, 'b@pa.test'), (:S1, 's1@pa.test');
select t.as_user(:A); select t.save('orgA', public.create_organization('Apps A', 'apps-a')); select t.reset();
select t.as_user(:B); select t.save('orgB', public.create_organization('Apps B', 'apps-b')); select t.reset();
insert into public.memberships (org_id, user_id, role_id) select t.id('orgA'), :S1::uuid, r.id from public.roles r where r.key = 'sales_agent' and r.org_id is null;

select t.as_user(:A);
select public.save_provider_app(t.id('orgA'), 'meta', '3431407853702583', :SEC, 'token-de-verificacion-largo-1');
select t.ok('el estado muestra el identificador y la fecha, y NUNCA la clave ni el token',
  (public.provider_app_status(t.id('orgA'), 'meta') ->> 'client_id') = '3431407853702583' and (public.provider_app_status(t.id('orgA'), 'meta') ->> 'has_verify_token')::boolean
  and public.provider_app_status(t.id('orgA'), 'meta')::text not like '%a1b2c3d4%' and public.provider_app_status(t.id('orgA'), 'meta')::text not like '%token-de-verificacion%');
select t.ok('una organización sin aplicación devuelve nulo', public.provider_app_status(t.id('orgA'), 'google') is null);
select t.throws('la tabla no se lee directamente', 'select count(*) from public.provider_apps', '42501');
select t.reset();

select t.as_service();
select t.ok('el servidor SÍ obtiene las credenciales de la organización',
  (public.provider_app_secrets(t.id('orgA'), 'meta') ->> 'secret') = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' and (public.provider_app_secrets(t.id('orgA'), 'meta') ->> 'verify_token') = 'token-de-verificacion-largo-1');
select t.ok('...y todas las aplicaciones de Meta para el webhook', (select count(*) = 1 and bool_and(secret is not null) from public.meta_apps_for_webhook()));
select t.reset();

-- permisos
select t.as_user(:S1);
select t.throws('un vendedor no guarda credenciales', format('select public.save_provider_app(%L, ''meta'', ''111111111111111'', %L, ''otro-token-verificacion-x'')', t.id('orgA'), :SEC), '42501');
select t.throws('ni ve su estado', format('select public.provider_app_status(%L, ''meta'')', t.id('orgA')), '42501');
select t.throws('ni las quita', format('select public.delete_provider_app(%L, ''meta'')', t.id('orgA')), '42501');
select t.reset();
select t.as_user(:B);
select t.throws('otra organización no toca las credenciales de A', format('select public.provider_app_status(%L, ''meta'')', t.id('orgA')), '42501');
select t.throws('un identificador de app pertenece a UNA sola organización', format('select public.save_provider_app(%L, ''meta'', ''3431407853702583'', %L, ''token-de-verificacion-largo-2'')', t.id('orgB'), :SEC), '23505');
select public.save_provider_app(t.id('orgB'), 'meta', '999999999999999', 'otra-clave-secreta-larga-123', 'token-de-verificacion-largo-2');
select t.reset();
select t.as_service(); select t.ok('cada organización tiene SU propia aplicación', (select count(*) = 2 from public.meta_apps_for_webhook())); select t.reset();

-- actualizar sin volver a enviar el token de verificación lo conserva
select t.as_user(:A); select public.save_provider_app(t.id('orgA'), 'meta', '3431407853702583', 'clave-nueva-de-la-app-abcdef12'); select t.reset();
select t.as_service();
select t.ok('cambiar la clave conserva el token de verificación ya registrado en Meta',
  (public.provider_app_secrets(t.id('orgA'), 'meta') ->> 'secret') = 'clave-nueva-de-la-app-abcdef12' and (public.provider_app_secrets(t.id('orgA'), 'meta') ->> 'verify_token') = 'token-de-verificacion-largo-1');
select t.reset();
-- validaciones
select t.as_user(:A);
select t.throws('el identificador de Meta son solo dígitos', format('select public.save_provider_app(%L, ''meta'', ''no-numerico'', %L, ''token-de-verificacion-largo-1'')', t.id('orgA'), :SEC), '23514');
select t.throws('una clave demasiado corta se rechaza', format('select public.save_provider_app(%L, ''meta'', ''3431407853702583'', ''corta'', ''token-de-verificacion-largo-1'')', t.id('orgA')), '23514');
select t.throws('un proveedor inventado se rechaza', format('select public.save_provider_app(%L, ''tiktok'', ''12345'', %L, null)', t.id('orgA'), :SEC), '23514');
select public.save_provider_app(t.id('orgA'), 'google', '1234567890-abc.apps.googleusercontent.com', 'GOCSPX-clave-de-google-abcdefg', null);
select t.ok('Google no necesita token de verificación', public.provider_app_status(t.id('orgA'), 'google') is not null);
select t.reset();

-- eventos sin secretos
select t.ok('el flujo de eventos anota que se guardó, SIN la clave',
  (select count(*) >= 2 from public.domain_events where type = 'provider_app.saved')
  and not exists (select 1 from public.domain_events where payload::text like '%a1b2c3d4e5f6%' or payload::text like '%clave-nueva%' or payload::text like '%token-de-verificacion%'));

-- quitar
select t.as_user(:A); select public.delete_provider_app(t.id('orgA'), 'meta'); select t.reset();
select t.as_user(:A); select t.ok('quitar borra las credenciales: el administrador ya no ve la aplicación', public.provider_app_status(t.id('orgA'), 'meta') is null); select t.reset();
select t.as_service(); select t.ok('el servidor ya no las encuentra', public.provider_app_secrets(t.id('orgA'), 'meta') is null and (select count(*) = 1 from public.meta_apps_for_webhook())); select t.reset();
select t.ok('se anota la eliminación', (select count(*) = 1 from public.domain_events where type = 'provider_app.removed'));

-- permisos de funciones
select t.ok('las funciones del servidor no las ejecuta ningún usuario ni anónimo',
  not has_function_privilege('authenticated', 'public.provider_app_secrets(uuid, text)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.meta_apps_for_webhook()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.save_provider_app(uuid, text, text, text, text)', 'EXECUTE') and not has_function_privilege('anon', 'public.provider_app_status(uuid, text)', 'EXECUTE'));
select t.ok('todas las tablas tienen RLS', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0);

rollback;
\echo ✔ CREDENCIALES DE APLICACIÓN: TODAS LAS PRUEBAS PASARON
