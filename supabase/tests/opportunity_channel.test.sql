-- Pruebas de 0020: el canal de una oportunidad sale del canal de la conversación del cliente (incluido Gmail → email).
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\o /dev/null

\set A  '''aaaaaaaa-c888-0000-0000-00000000000a'''
\set PID '''339876543210'''

begin;
\i supabase/tests/support/test_helpers.sql
insert into auth.users (id, email) values (:A, 'a@oc.test');
select t.as_user(:A); select t.save('org', public.create_organization('Canal Opp', 'canal-opp'));
select t.save('wa', public.create_channel(t.id('org'), 'Ventas', :PID, '+57 300 000 0000', 'EAAB-token-abcdefghijklmnopqrstuvwxyz'));
select t.save('gm', public.connect_channel(t.id('org'), 'gmail', 'Ventas', 'ventas@arkos.co', null, 'Ventas', '1//refresh-token-abcdefghijklmnop'));
select t.save('fb', public.connect_channel(t.id('org'), 'facebook', 'Página', '100000000000123', null, 'Página', 'EAAB-page-token-abcdefghijklmnopqrstu'));
select t.save('ig', public.connect_channel(t.id('org'), 'instagram', 'IG', '17841400000000123', '@arkos', 'IG', 'EAAB-page-token-abcdefghijklmnopqrstu'));
select t.save('c_gm', (public.create_customer(t.id('org'), 'person', 'Cliente Gmail', '[{"type":"email","value":"cliente.gmail@ejemplo.com"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('c_wa', (public.create_customer(t.id('org'), 'person', 'Cliente WA', '[{"type":"phone","value":"+573001110055"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('c_fb', (public.create_customer(t.id('org'), 'person', 'Cliente FB', '[{"type":"facebook","value":"5500000000000123"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('c_ig', (public.create_customer(t.id('org'), 'person', 'Cliente IG', '[{"type":"instagram","value":"5500000000000124"}]'::jsonb) ->> 'customer_id')::uuid);
select t.save('c_none', (public.create_customer(t.id('org'), 'person', 'Cliente sin chat', '[{"type":"phone","value":"+573001110056"}]'::jsonb) ->> 'customer_id')::uuid);
select t.reset();
select t.as_service();
select public.ingest_channel_message('gmail', 'ventas@arkos.co', 'cliente.gmail@ejemplo.com', 'Cliente', 'gm.1', 'text', 'hola', now());
select public.ingest_whatsapp_message(:PID, '573001110055', 'Ana', 'wamid.1', 'text', 'hola', now());
select public.ingest_channel_message('facebook', '100000000000123', '5500000000000123', null, 'mid.1', 'text', 'hola', now());
select public.ingest_channel_message('instagram', '17841400000000123', '5500000000000124', null, 'mid.2', 'text', 'hola', now());
select t.reset();

select t.as_user(:A);
select t.save('o_gm', public.create_opportunity(t.id('c_gm'), 'Desde Gmail', 1000, null, null, null));
select t.save('o_wa', public.create_opportunity(t.id('c_wa'), 'Desde WhatsApp', 1000, null, null, null));
select t.save('o_fb', public.create_opportunity(t.id('c_fb'), 'Desde Messenger', 1000, null, null, null));
select t.save('o_ig', public.create_opportunity(t.id('c_ig'), 'Desde Instagram', 1000, null, null, null));
select t.save('o_none', public.create_opportunity(t.id('c_none'), 'Sin conversación', 1000, null, null, null));
select t.reset();

select t.ok('un cliente que escribió por GMAIL puede tener oportunidad; su canal es «email» y queda ligada a la conversación',
  (select channel = 'email' and conversation_id = (select id from public.conversations where thread_key = 'cliente.gmail@ejemplo.com') from public.opportunities where id = t.id('o_gm')));
select t.ok('WhatsApp, Messenger e Instagram siguen igual (su canal coincide)',
  (select channel = 'whatsapp' from public.opportunities where id = t.id('o_wa'))
  and (select channel = 'facebook' from public.opportunities where id = t.id('o_fb'))
  and (select channel = 'instagram' from public.opportunities where id = t.id('o_ig')));
select t.ok('sin conversación no hay canal ni vínculo (como siempre)', (select channel is null and conversation_id is null from public.opportunities where id = t.id('o_none')));
insert into public.opportunities (org_id, customer_id, pipeline_id, stage_id, title, amount, owner_id, channel)
  select org_id, customer_id, pipeline_id, stage_id, 'Con canal elegido', 1, owner_id, 'web' from public.opportunities where id = t.id('o_gm');
select t.ok('un canal elegido a mano NO se pisa, aunque la conversación sea de Gmail', (select channel = 'web' and conversation_id is not null from public.opportunities where title = 'Con canal elegido'));
select t.as_user(:A);
select t.save('o_gm2', public.create_opportunity(t.id('c_gm'), 'Otra', 1, null, null, null));
select public.link_opportunity_conversation(t.id('o_none'), null);
select t.reset();
select t.ok('la numeración sigue correlativa e inmutable', (select count(distinct number) = 7 from public.opportunities where org_id = t.id('org')));
select t.throws('el número no se puede cambiar', format('update public.opportunities set number = ''OPP-9999'' where id = %L', t.id('o_gm')), '23514');

rollback;
\echo ✔ CANAL DE OPORTUNIDADES: TODAS LAS PRUEBAS PASARON
