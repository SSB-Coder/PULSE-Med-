-- Run in the Supabase SQL Editor for the project used by PULSE.
-- Re-runnable. No service-role key is needed by the PULSE backend.
begin;

create or replace function public.valid_pulse_history(payload jsonb)
returns boolean language sql immutable strict set search_path = '' as $$
    select case when jsonb_typeof(payload) <> 'object' then false else
        not exists (
            select 1 from jsonb_each(payload) as entry(key, value)
            where key not in ('conditions', 'medications', 'allergies', 'surgeries', 'family_history', 'notes')
               or jsonb_typeof(value) <> 'string'
               or length(value #>> '{}') > case key
                    when 'conditions' then 3000 when 'medications' then 3000
                    when 'notes' then 12000 else 2000 end
        ) end;
$$;

create table if not exists public.medical_profiles (
    user_id uuid primary key references auth.users(id) on delete cascade,
    history jsonb not null default '{}'::jsonb check (public.valid_pulse_history(history)),
    updated_at timestamptz not null default now()
);

create or replace function public.touch_pulse_profile()
returns trigger language plpgsql set search_path = '' as $$
begin
    new.updated_at = now();
    return new;
end;
$$;
drop trigger if exists pulse_profile_updated on public.medical_profiles;
create trigger pulse_profile_updated before update on public.medical_profiles
    for each row execute function public.touch_pulse_profile();

alter table public.medical_profiles enable row level security;
revoke all on public.medical_profiles from anon;
grant select, insert, update, delete on public.medical_profiles to authenticated;

drop policy if exists "Read own medical profile" on public.medical_profiles;
create policy "Read own medical profile" on public.medical_profiles for select to authenticated
    using ((select auth.uid()) = user_id);
drop policy if exists "Insert own medical profile" on public.medical_profiles;
create policy "Insert own medical profile" on public.medical_profiles for insert to authenticated
    with check ((select auth.uid()) = user_id);
drop policy if exists "Update own medical profile" on public.medical_profiles;
create policy "Update own medical profile" on public.medical_profiles for update to authenticated
    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Delete own medical profile" on public.medical_profiles;
create policy "Delete own medical profile" on public.medical_profiles for delete to authenticated
    using ((select auth.uid()) = user_id);

commit;
