-- Helpers compartidos por las pruebas SQL (se incluyen dentro de una transacción abierta).
create schema t;
grant usage on schema t to public;
create table t.ctx (k text primary key, v uuid);
grant select on t.ctx to public;

create function t.id(p text) returns uuid language sql stable as $$ select v from t.ctx where k = p $$;
create function t.save(p text, v uuid) returns uuid language sql security definer as
  $$ insert into t.ctx values (p, v) returning v $$;

-- Ejecuta un DML y devuelve las filas afectadas. Tokens: {orgA} {A} ... desde t.ctx.
create function t.affected(p_sql text) returns bigint language plpgsql as $$
declare v_n bigint; v_sql text := p_sql; r record;
begin
  for r in select k, v from t.ctx loop
    v_sql := replace(v_sql, '{' || r.k || '}', quote_literal(r.v::text));
  end loop;
  execute v_sql;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create function t.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function t.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
end $$;
create function t.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'service_role', true);
end $$;
create function t.reset() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'none', true);
end $$;

create function t.ok(p_name text, p_cond boolean) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL: %', p_name; end if;
  raise notice 'ok    - %', p_name;
end $$;

create function t.throws(p_name text, p_sql text, p_state text default null) returns void
language plpgsql as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if p_state is not null and v_state <> p_state then
      raise exception 'FAIL: % (esperado %, obtenido %)', p_name, p_state, v_state;
    end if;
    raise notice 'ok    - % [%]', p_name, v_state;
    return;
  end;
  raise exception 'FAIL: % (no lanzó error)', p_name;
end $$;

