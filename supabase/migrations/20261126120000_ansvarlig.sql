-- Ansvarlig person: hvem der pakkede (pakninger.af), og hvem der gjorde hvad i historikken (historik.person).
-- Ændrer ingen eksisterende data. Ældre pakninger og historiklinjer står uden person.

alter table public.pakninger add column af text check (af is null or char_length(af) between 1 and 80);
alter table public.historik add column person text check (person is null or char_length(person) <= 80);


-- Som i 20261126110000_historik.sql, nu med person
create or replace function public.log_historik(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_antal integer;
begin
  insert into public.historik (kategori, handling, emne, tekst, detaljer, enhed, person)
  select x->>'kategori', x->>'handling', x->>'emne', x->>'tekst', x->'detaljer', x->>'enhed', nullif(x->>'person', '')
  from jsonb_array_elements(coalesce(p->'poster', '[]'::jsonb)) x;
  get diagnostics v_antal = row_count;
  return jsonb_build_object('ok', true, 'antal', v_antal);
end;
$$;


-- Som i 20261126110000_historik.sql, nu med person (også i søgningen)
create or replace function public.hent_historik(p jsonb default '{}'::jsonb)
returns jsonb language sql stable set search_path = '' as $$
  with valgt as (
    select h.* from public.historik h
    where (p->>'foer' is null or h.id < (p->>'foer')::bigint)
      and (p->>'kategori' is null or h.kategori = p->>'kategori')
      and (coalesce(p->>'soeg', '') = '' or position(lower(p->>'soeg') in
            lower(concat_ws(' ', h.handling, h.emne, h.tekst, h.enhed, h.person))) > 0)
    order by h.id desc
    limit least(greatest(coalesce((p->>'antal')::integer, 100), 1), 500) + 1
  ), side as (
    select * from valgt order by id desc limit least(greatest(coalesce((p->>'antal')::integer, 100), 1), 500)
  )
  select jsonb_build_object(
    'poster', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'tid', s.tid, 'kategori', s.kategori,
      'handling', s.handling, 'emne', s.emne, 'tekst', s.tekst, 'detaljer', s.detaljer, 'enhed', s.enhed, 'person', s.person)
      order by s.id desc) from side s), '[]'::jsonb),
    'flere', (select count(*) from valgt) > (select count(*) from side)
  );
$$;


-- Som i 20261116100000_faelles_data.sql, nu med af (hvem der pakkede) i pakningerne
create or replace function public.hent_data(p jsonb default '{}'::jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'personer', coalesce((select jsonb_agg(x.navn order by x.oprettet, x.navn) from public.personer x), '[]'::jsonb),
    'produkter', coalesce((select jsonb_agg(x.data order by x.id) from public.produkter x), '[]'::jsonb),
    'batches', coalesce((select jsonb_agg(x.data order by x.no) from public.batches x), '[]'::jsonb),
    'reservationer', coalesce((select jsonb_agg(x.data order by x.id) from public.reservationer x), '[]'::jsonb),
    'pakninger', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ref', k.ref, 'pid', k.pid, 'antal', k.antal, 'kasseret', k.kasseret, 'status', k.status,
        'rackbeatId', k.rackbeat_id, 'dato', k.dato, 'af', k.af,
        'linjer', (select coalesce(jsonb_agg(jsonb_build_object('batch', l.batch_no, 'antal', l.antal, 'kasseret', l.kasseret)
                     order by l.batch_no), '[]'::jsonb) from public.pakning_linjer l where l.ref = k.ref)
      ) order by k.oprettet, k.ref)
      from public.pakninger k), '[]'::jsonb)
  );
$$;


create or replace function public.pakning_som_json(p_ref text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'ref', k.ref, 'pid', k.pid, 'sku', k.sku, 'antal', k.antal, 'kasseret', k.kasseret, 'status', k.status,
    'rackbeatId', k.rackbeat_id, 'dato', k.dato, 'af', k.af,
    'linjer', (select coalesce(jsonb_agg(jsonb_build_object('batch', l.batch_no, 'label', b.data->>'label',
                 'antal', l.antal, 'kasseret', l.kasseret) order by (b.data->>'made')::date, l.batch_no), '[]'::jsonb)
               from public.pakning_linjer l left join public.batches b on b.no = l.batch_no where l.ref = k.ref))
  from public.pakninger k where k.ref = p_ref;
$$;


-- Som i 20261116100000_faelles_data.sql, nu gemmes p.af (hvem der pakkede)
create or replace function public.reserver_pakning(p jsonb)
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

  insert into public.pakninger (ref, pid, sku, antal, kasseret, dato, af)
  values (v_ref, v_pid, p->>'sku', v_antal, v_kasseret, v_idag, nullif(p->>'af', ''));
  insert into public.pakning_linjer (ref, batch_no, antal, kasseret)
  select v_ref, (x->>'batch')::bigint, (x->>'antal')::integer, (x->>'kasseret')::integer from jsonb_array_elements(v_linjer) x;

  return public.pakning_som_json(v_ref) || jsonb_build_object('ny', true);
end;
$$;


revoke all on function public.log_historik(jsonb), public.hent_historik(jsonb), public.hent_data(jsonb),
  public.pakning_som_json(text), public.reserver_pakning(jsonb) from public, anon, authenticated;
grant execute on function public.log_historik(jsonb), public.hent_historik(jsonb), public.hent_data(jsonb),
  public.pakning_som_json(text), public.reserver_pakning(jsonb) to service_role;
