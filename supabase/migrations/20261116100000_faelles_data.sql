-- Fælles data for produktionskalenderen (V3): personer, produkter, batches, reservationer og produktionslager.
--
-- Kun Vercel-serveren taler med databasen, med den hemmelige nøgle (service_role). Browseren har ingen nøgle.
-- Derfor har tabellerne RLS uden politikker, og funktionerne kan kun kaldes af service_role:
-- en offentlig (anon) nøgle kan hverken læse, skrive eller kalde funktionerne.
--
-- Personer, produkter, batches og reservationer gemmes som det JSON-objekt, kalenderen bruger (data).
-- Pakninger (produktionslageret) har faste kolonner, fordi kun serveren skriver dem.

create table public.personer (
  navn text primary key check (char_length(navn) between 1 and 80),
  oprettet timestamptz not null default now()
);

create table public.produkter (
  id text primary key,
  data jsonb not null,
  opdateret timestamptz not null default now()
);

create table public.batches (
  no bigint primary key,
  data jsonb not null,
  opdateret timestamptz not null default now()
);

create table public.reservationer (
  id text primary key,
  data jsonb not null,
  opdateret timestamptz not null default now()
);

-- En pakning er et antal stk., der er taget ud af produktionslageret. antal er alt, der er taget ud,
-- kasseret er de stk., der havde fejl. Resten (antal - kasseret) er godkendt og lagt på lager i Rackbeat.
-- status er 'reserveret', mens Rackbeat opdateres, og 'bogfoert', når reguleringen er bogført.
create table public.pakninger (
  ref text primary key check (ref ~ '^[a-z0-9-]{8,64}$'),
  pid text not null,
  sku text,
  antal integer not null check (antal > 0),
  kasseret integer not null default 0 check (kasseret >= 0 and kasseret <= antal),
  status text not null default 'reserveret' check (status in ('reserveret', 'bogfoert')),
  rackbeat_id bigint,
  dato date not null,
  oprettet timestamptz not null default now()
);

-- Hvor meget hver batch bidrog med til en pakning (ældste batch først)
create table public.pakning_linjer (
  ref text not null references public.pakninger (ref) on delete cascade,
  batch_no bigint not null,
  antal integer not null check (antal > 0),
  kasseret integer not null default 0 check (kasseret >= 0 and kasseret <= antal),
  primary key (ref, batch_no)
);
create index pakning_linjer_batch on public.pakning_linjer (batch_no);

alter table public.personer enable row level security;
alter table public.produkter enable row level security;
alter table public.batches enable row level security;
alter table public.reservationer enable row level security;
alter table public.pakninger enable row level security;
alter table public.pakning_linjer enable row level security;

revoke all on public.personer, public.produkter, public.batches, public.reservationer,
  public.pakninger, public.pakning_linjer from anon, authenticated;


-- Alle data i ét kald
create function public.hent_data(p jsonb default '{}'::jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'personer', coalesce((select jsonb_agg(x.navn order by x.oprettet, x.navn) from public.personer x), '[]'::jsonb),
    'produkter', coalesce((select jsonb_agg(x.data order by x.id) from public.produkter x), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(x.data order by x.no) from public.batches x), '[]'::jsonb),
    'reservationer', coalesce((select jsonb_agg(x.data order by x.id) from public.reservationer x), '[]'::jsonb),
    'pakninger', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ref', k.ref, 'pid', k.pid, 'antal', k.antal, 'kasseret', k.kasseret, 'status', k.status,
        'rackbeatId', k.rackbeat_id, 'dato', k.dato,
        'linjer', (select coalesce(jsonb_agg(jsonb_build_object('batch', l.batch_no, 'antal', l.antal, 'kasseret', l.kasseret)
                     order by l.batch_no), '[]'::jsonb) from public.pakning_linjer l where l.ref = k.ref)
      ) order by k.oprettet, k.ref)
      from public.pakninger k), '[]'::jsonb)
  );
$$;


-- Gemmer ændringer fra en kalender i én transaktion.
-- p = {"batches": {"gem": [...], "slet": [no, ...]}, "reservationer": {"gem": [...], "slet": [id, ...]},
--      "produkter": {"gem": [...], "slet": [id, ...]}, "personer": {"gem": ["navn", ...]}}
-- En batch, der indgår i en pakning, kan ikke slettes, for så ville produktionslageret ikke kunne regnes.
create function public.gem_data(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
begin
  insert into public.batches (no, data, opdateret)
  select (x->>'no')::bigint, x, now() from jsonb_array_elements(coalesce(p #> '{batches,gem}', '[]'::jsonb)) x
  on conflict (no) do update set data = excluded.data, opdateret = now();
  delete from public.batches b
  where b.no in (select (x #>> '{}')::bigint from jsonb_array_elements(coalesce(p #> '{batches,slet}', '[]'::jsonb)) x)
    and not exists (select 1 from public.pakning_linjer l where l.batch_no = b.no);

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


-- Tager antal stk. ud af produktionslageret for et produkt: ældste batch, der er klar, først.
-- Kun batches, der er lavet og har hærdet færdigt (made + cure <= idag), kan pakkes.
-- Kasserede stk. regnes fra de første batches i rækkefølgen.
-- Samme ref giver samme pakning igen, så et nyt forsøg efter en fejl ikke tager stk. ud to gange.
-- p = {"ref", "pid", "sku", "antal", "kasseret", "idag"}
create function public.reserver_pakning(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_ref text := p->>'ref';
  v_pid text := p->>'pid';
  v_antal integer := (p->>'antal')::integer;
  v_kasseret integer := coalesce((p->>'kasseret')::integer, 0);
  v_idag date := (p->>'idag')::date;
  v_mangler integer;
  v_kas_rest integer;
  v_tag integer;
  v_kas integer;
  v_klar integer := 0;
  r record;
  v_linjer jsonb := '[]'::jsonb;
begin
  if exists (select 1 from public.pakninger k where k.ref = v_ref) then
    return public.pakning_som_json(v_ref) || jsonb_build_object('ny', false);
  end if;
  if v_pid is null or v_idag is null or v_antal is null or v_antal < 1 or v_kasseret < 0 or v_kasseret > v_antal then
    raise exception 'ugyldig_pakning';
  end if;

  -- Låser produktets batches, så to samtidige pakninger ikke kan tage de samme stk.
  perform 1 from public.batches b where b.data->>'pid' = v_pid for update;

  v_mangler := v_antal;
  v_kas_rest := v_kasseret;
  for r in
    select b.no, b.data->>'label' as label,
      (b.data->>'qty')::integer - coalesce((b.data->>'rejected')::integer, 0)
        - coalesce((select sum(l.antal) from public.pakning_linjer l where l.batch_no = b.no), 0) as rest
    from public.batches b
    where b.data->>'pid' = v_pid and b.data->>'status' = 'aktiv'
      and (b.data->>'made')::date + coalesce((b.data->>'cure')::integer, 0) <= v_idag
    order by (b.data->>'made')::date, b.no
  loop
    continue when r.rest <= 0;
    v_klar := v_klar + r.rest;
    if v_mangler > 0 then
      v_tag := least(r.rest, v_mangler);
      v_kas := least(v_kas_rest, v_tag);
      v_linjer := v_linjer || jsonb_build_object('batch', r.no, 'label', r.label, 'antal', v_tag, 'kasseret', v_kas);
      v_mangler := v_mangler - v_tag;
      v_kas_rest := v_kas_rest - v_kas;
    end if;
  end loop;

  if v_mangler > 0 then
    raise exception 'ikke_nok_klar' using detail = v_klar::text;
  end if;

  insert into public.pakninger (ref, pid, sku, antal, kasseret, dato)
  values (v_ref, v_pid, p->>'sku', v_antal, v_kasseret, v_idag);
  insert into public.pakning_linjer (ref, batch_no, antal, kasseret)
  select v_ref, (x->>'batch')::bigint, (x->>'antal')::integer, (x->>'kasseret')::integer from jsonb_array_elements(v_linjer) x;

  return public.pakning_som_json(v_ref) || jsonb_build_object('ny', true);
end;
$$;


-- Markerer pakningen som bogført i Rackbeat
create function public.bekraeft_pakning(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
begin
  update public.pakninger set status = 'bogfoert', rackbeat_id = nullif(p->>'rackbeatId', '')::bigint
  where ref = p->>'ref';
  if not found then raise exception 'ukendt_pakning'; end if;
  return public.pakning_som_json(p->>'ref');
end;
$$;


-- Fortryder en pakning, der ikke blev bogført i Rackbeat. En bogført pakning kan ikke fortrydes her.
create function public.annuller_pakning(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
begin
  delete from public.pakninger where ref = p->>'ref' and status = 'reserveret';
  return jsonb_build_object('annulleret', found);
end;
$$;


-- Hjælper: én pakning med linjer og batchnumre
create function public.pakning_som_json(p_ref text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'ref', k.ref, 'pid', k.pid, 'sku', k.sku, 'antal', k.antal, 'kasseret', k.kasseret, 'status', k.status,
    'rackbeatId', k.rackbeat_id, 'dato', k.dato,
    'linjer', (select coalesce(jsonb_agg(jsonb_build_object('batch', l.batch_no, 'label', b.data->>'label',
                 'antal', l.antal, 'kasseret', l.kasseret) order by (b.data->>'made')::date, l.batch_no), '[]'::jsonb)
               from public.pakning_linjer l left join public.batches b on b.no = l.batch_no where l.ref = k.ref))
  from public.pakninger k where k.ref = p_ref;
$$;


-- Kun serveren (service_role) må kalde funktionerne
revoke all on function public.hent_data(jsonb), public.gem_data(jsonb), public.reserver_pakning(jsonb),
  public.bekraeft_pakning(jsonb), public.annuller_pakning(jsonb), public.pakning_som_json(text)
  from public, anon, authenticated;
grant execute on function public.hent_data(jsonb), public.gem_data(jsonb), public.reserver_pakning(jsonb),
  public.bekraeft_pakning(jsonb), public.annuller_pakning(jsonb), public.pakning_som_json(text)
  to service_role;
