create extension if not exists pgcrypto;

grant usage on schema public to anon, authenticated;

create table if not exists public.noteboard_sync_spaces (
  id uuid primary key default gen_random_uuid(),
  sync_code text not null unique,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.noteboard_sync_spaces enable row level security;
revoke all on public.noteboard_sync_spaces from anon, authenticated;

drop function if exists public.noteboard_create_space(text, jsonb);
drop function if exists public.noteboard_pull(text);
drop function if exists public.noteboard_push(text, jsonb, bigint);

create or replace function public.noteboard_create_space(
  p_sync_code text,
  p_payload jsonb
)
returns table(sync_code text, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.noteboard_sync_spaces(sync_code, payload, revision)
  values (upper(trim(p_sync_code)), coalesce(p_payload, '{}'::jsonb), 1);

  return query
    select s.sync_code, s.revision, s.updated_at
    from public.noteboard_sync_spaces s
    where s.sync_code = upper(trim(p_sync_code));
end;
$$;

create or replace function public.noteboard_pull(p_sync_code text)
returns table(payload jsonb, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select s.payload, s.revision, s.updated_at
    from public.noteboard_sync_spaces s
    where s.sync_code = upper(trim(p_sync_code));
end;
$$;

create or replace function public.noteboard_push(
  p_sync_code text,
  p_payload jsonb,
  p_base_revision bigint default null
)
returns table(ok boolean, conflict boolean, payload jsonb, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.noteboard_sync_spaces%rowtype;
  next_payload jsonb;
  next_revision bigint;
  next_updated_at timestamptz;
begin
  select *
    into current_row
    from public.noteboard_sync_spaces
    where sync_code = upper(trim(p_sync_code))
    for update;

  if not found then
    return query select false, false, null::jsonb, 0::bigint, null::timestamptz;
    return;
  end if;

  if p_base_revision is not null and current_row.revision <> p_base_revision then
    return query
      select false, true, current_row.payload, current_row.revision, current_row.updated_at;
    return;
  end if;

  update public.noteboard_sync_spaces
    set payload = coalesce(p_payload, '{}'::jsonb),
        revision = revision + 1,
        updated_at = now()
    where sync_code = upper(trim(p_sync_code))
    returning noteboard_sync_spaces.payload,
              noteboard_sync_spaces.revision,
              noteboard_sync_spaces.updated_at
    into next_payload, next_revision, next_updated_at;

  return query
    select true, false, next_payload, next_revision, next_updated_at;
end;
$$;

grant execute on function public.noteboard_create_space(text, jsonb) to anon, authenticated;
grant execute on function public.noteboard_pull(text) to anon, authenticated;
grant execute on function public.noteboard_push(text, jsonb, bigint) to anon, authenticated;

notify pgrst, 'reload schema';

select routine_name, data_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('noteboard_create_space', 'noteboard_pull', 'noteboard_push')
order by routine_name;
