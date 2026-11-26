-- Historik: hver ændring og handling i kalenderen med tidspunkt, til fejlfinding.
-- Serveren skriver linjerne (læsbar tekst og de felter, der blev ændret). Ændringer fra kalenderen skrives i samme
-- transaktion som selve ændringen (gem_data), så historikken altid passer med data. Pakninger og fejl skrives af
-- serveren undervejs (log_historik). Ingen linjer ændres eller slettes bagefter.
--
-- Som de andre tabeller: RLS uden politikker, og kun serveren (service_role) kan kalde funktionerne.

create table public.historik (
  id bigint generated always as identity primary key,
  tid timestamptz not null default now(),
  kategori text not null check (kategori in ('batch', 'bestilling', 'produkt', 'person', 'pakning', 'fejl')),
  handling text not null check (char_length(handling) between 1 and 200),
  emne text check (char_length(emne) <= 300),
  tekst text check (char_length(tekst) <= 4000),
  detaljer jsonb,
  enhed text check (char_length(enhed) <= 120)
);
create index historik_tid on public.historik (tid desc, id desc);

alter table public.historik enable row level security;
revoke all on public.historik from anon, authenticated;


-- Skriver linjer. p = {"poster": [{"kategori", "handling", "emne", "tekst", "detaljer", "enhed"}, ...]}
create function public.log_historik(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_antal integer;
begin
  insert into public.historik (kategori, handling, emne, tekst, detaljer, enhed)
  select x->>'kategori', x->>'handling', x->>'emne', x->>'tekst', x->'detaljer', x->>'enhed'
  from jsonb_array_elements(coalesce(p->'poster', '[]'::jsonb)) x;
  get diagnostics v_antal = row_count;
  return jsonb_build_object('ok', true, 'antal', v_antal);
end;
$$;


-- Nyeste først. p = {"foer": id (kun ældre end den), "antal": 1-500, "kategori": "...", "soeg": "tekst"}
-- soeg finder teksten i hvad, handling, detaljer eller enhed (uden store/små bogstaver).
create function public.hent_historik(p jsonb default '{}'::jsonb)
returns jsonb language sql stable set search_path = '' as $$
  with valgt as (
    select h.* from public.historik h
    where (p->>'foer' is null or h.id < (p->>'foer')::bigint)
      and (p->>'kategori' is null or h.kategori = p->>'kategori')
      and (coalesce(p->>'soeg', '') = '' or position(lower(p->>'soeg') in
            lower(concat_ws(' ', h.handling, h.emne, h.tekst, h.enhed))) > 0)
    order by h.id desc
    limit least(greatest(coalesce((p->>'antal')::integer, 100), 1), 500) + 1
  ), side as (
    select * from valgt order by id desc limit least(greatest(coalesce((p->>'antal')::integer, 100), 1), 500)
  )
  select jsonb_build_object(
    'poster', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'tid', s.tid, 'kategori', s.kategori,
      'handling', s.handling, 'emne', s.emne, 'tekst', s.tekst, 'detaljer', s.detaljer, 'enhed', s.enhed) order by s.id desc)
      from side s), '[]'::jsonb),
    'flere', (select count(*) from valgt) > (select count(*) from side)
  );
$$;


-- gem_data som i 20261126100000_slet_batch_med_pakninger.sql, og skriver nu også p.historik i samme transaktion
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

  perform public.log_historik(jsonb_build_object('poster', coalesce(p->'historik', '[]'::jsonb)));

  return jsonb_build_object('ok', true);
end;
$$;


revoke all on function public.log_historik(jsonb), public.hent_historik(jsonb), public.gem_data(jsonb)
  from public, anon, authenticated;
grant execute on function public.log_historik(jsonb), public.hent_historik(jsonb), public.gem_data(jsonb)
  to service_role;
