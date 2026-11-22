-- Run after schema.sql and chat_history_migration.sql. Safe to rerun.
begin;
alter table public.conversations add column if not exists web_enabled boolean not null default false;

-- Private usage counters only: never store queries, transcripts, or medical history.
create table if not exists public.pulse_web_account_budget (
    user_id uuid primary key references auth.users(id) on delete cascade,
    minute_at timestamptz not null, minute_count integer not null,
    day_at date not null, day_count integer not null
);
create table if not exists public.pulse_web_global_budget (
    id boolean primary key default true check (id),
    minute_at timestamptz not null, minute_count integer not null,
    day_at date not null, day_count integer not null
);
alter table public.pulse_web_account_budget enable row level security;
alter table public.pulse_web_global_budget enable row level security;
revoke all on public.pulse_web_account_budget, public.pulse_web_global_budget from public, anon, authenticated;

create or replace function public.claim_pulse_web_budget()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
    owner_id uuid := auth.uid();
    current_minute timestamptz := date_trunc('minute', now());
    current_day date := (now() at time zone 'UTC')::date;
    global_row public.pulse_web_global_budget%rowtype;
    account_row public.pulse_web_account_budget%rowtype;
    gm integer; gd integer; am integer; ad integer;
begin
    if owner_id is null then return false; end if;
    insert into public.pulse_web_global_budget values (true, current_minute, 0, current_day, 0)
        on conflict (id) do nothing;
    select * into global_row from public.pulse_web_global_budget where id = true for update;
    insert into public.pulse_web_account_budget values (owner_id, current_minute, 0, current_day, 0)
        on conflict (user_id) do nothing;
    select * into account_row from public.pulse_web_account_budget where user_id = owner_id for update;
    gm := case when global_row.minute_at = current_minute then global_row.minute_count else 0 end;
    gd := case when global_row.day_at = current_day then global_row.day_count else 0 end;
    am := case when account_row.minute_at = current_minute then account_row.minute_count else 0 end;
    ad := case when account_row.day_at = current_day then account_row.day_count else 0 end;
    -- Atomic fixed caps, independent of browser or model-provided arguments.
    if gm >= 30 or gd >= 500 or am >= 5 or ad >= 50 then return false; end if;
    update public.pulse_web_global_budget set minute_at=current_minute, minute_count=gm+1,
        day_at=current_day, day_count=gd+1 where id=true;
    update public.pulse_web_account_budget set minute_at=current_minute, minute_count=am+1,
        day_at=current_day, day_count=ad+1 where user_id=owner_id;
    return true;
end;
$$;
revoke all on function public.claim_pulse_web_budget() from public, anon;
grant execute on function public.claim_pulse_web_budget() to authenticated;
notify pgrst, 'reload schema';
commit;
