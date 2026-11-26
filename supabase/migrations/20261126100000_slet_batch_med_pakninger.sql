-- En batch kan slettes, også når der er pakket fra den (fx testdata). Batchens linjer i pakningerne slettes med,
-- og en pakning uden linjer bagefter slettes. Det, der er lagt på lager i Rackbeat, røres ikke.
-- En batch med en pakning, der venter på Rackbeat (reserveret), slettes ikke, før pakningen er færdig.
-- Resten af gem_data er uændret fra 20261116100000_faelles_data.sql.

create or replace function public.gem_data(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_slet bigint[];
  v_refs text[];
begin
  insert into public.batches (no, data, opdateret)
  select (x->>'no')::bigint, x, now() from jsonb_array_elements(coalesce(p #> '{batches,gem}', '[]'::jsonb)) x
  on conflict (no) do update set data = excluded.data, opdateret = now();

  select coalesce(array_agg(n), '{}') into v_slet
  from (select (x #>> '{}')::bigint as n from jsonb_array_elements(coalesce(p #> '{batches,slet}', '[]'::jsonb)) x) s
  where not exists (select 1 from public.pakning_linjer l join public.pakninger k on k.ref = l.ref
                    where l.batch_no = s.n and k.status = 'reserveret');
  with d as (delete from public.pakning_linjer l where l.batch_no = any(v_slet) returning l.ref)
  select coalesce(array_agg(distinct d.ref), '{}') into v_refs from d;
  delete from public.pakninger k
  where k.ref = any(v_refs) and not exists (select 1 from public.pakning_linjer l where l.ref = k.ref);
  delete from public.batches b where b.no = any(v_slet);

  insert into public.reservationer (id, data, opdateret)
  select x->>'id', x, now() from jsonb_array_elements(coalesce(p #> '{reservationer,gem}', '[]'::jsonb)) x
  on conflict (id) do update set data = excluded.data, opdateret = now();
  delete from public.reservationer
  where id in (select x #>> '{}' from jsonb_array_elements(coalesce(p #> '{reservationer,slet}', '[]'::jsonb)) x);

  insert into public.produkter (id, data, opdateret)
  select x->>'id', x, now() from jsonb_array_elements(coalesce(p #> '{produkter,gem}', '[]'::jsonb)) x
  on conflict (id) do update set data = excluded.data, opdateret = now();
  delete from public.produkter
  where id in (select x #>> '{}' from jsonb_array_elements(coalesce(p #> '{produkter,slet}', '[]'::jsonb)) x);

  insert into public.personer (navn)
  select x #>> '{}' from jsonb_array_elements(coalesce(p #> '{personer,gem}', '[]'::jsonb)) x
  on conflict (navn) do nothing;

  return jsonb_build_object('ok', true);
end;
$$;

-- create or replace beholder rettighederne, men de gentages for en sikkerheds skyld
revoke all on function public.gem_data(jsonb) from public, anon, authenticated;
grant execute on function public.gem_data(jsonb) to service_role;
