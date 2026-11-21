-- Run AFTER schema.sql in Supabase SQL Editor. Safe to run again.
begin;

create table if not exists public.medical_records (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null check (length(btrim(name)) between 1 and 100),
    history jsonb not null default '{}'::jsonb check (public.valid_pulse_history(history)),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, id)
);
create index if not exists medical_records_owner_updated on public.medical_records(user_id, updated_at desc);
drop trigger if exists medical_record_updated on public.medical_records;
create trigger medical_record_updated before update on public.medical_records
    for each row execute function public.touch_pulse_profile();

-- Copy each legacy profile once. Re-running this migration must not restore deleted records.
alter table public.medical_profiles add column if not exists records_migrated_at timestamptz;
insert into public.medical_records(user_id, name, history, updated_at)
    select user_id, 'Medical history', history, updated_at
    from public.medical_profiles where records_migrated_at is null;
-- Remove the duplicate legacy contents only after the copy succeeds, in this transaction.
update public.medical_profiles set history = '{}'::jsonb, records_migrated_at = now()
    where records_migrated_at is null;

create or replace function public.valid_pulse_messages(payload jsonb)
returns boolean language sql immutable strict set search_path = '' as $$
    select case when jsonb_typeof(payload) <> 'array' then false else
        jsonb_array_length(payload) <= 200 and octet_length(payload::text) <= 4000000
        and not exists (
            select 1 from jsonb_array_elements(payload) m
            where jsonb_typeof(m) <> 'object'
               or coalesce(m->>'role', '') not in ('user', 'assistant')
               or coalesce(jsonb_typeof(m->'content'), '') <> 'string'
               or length(coalesce(m->>'content', '')) not between 1 and 16000
        ) end;
$$;

create table if not exists public.conversations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    title text not null default 'New chat' check (length(title) between 1 and 70),
    messages jsonb not null default '[]'::jsonb check (public.valid_pulse_messages(messages)),
    medical_record_id uuid,
    use_history boolean not null default false,
    revision integer not null default 1 check (revision > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Composite FK also prevents linking another user's record through the Data API.
    foreign key (user_id, medical_record_id) references public.medical_records(user_id, id)
        on delete set null (medical_record_id)
);
create index if not exists conversations_owner_updated on public.conversations(user_id, updated_at desc);
drop trigger if exists conversation_updated on public.conversations;
create trigger conversation_updated before update on public.conversations
    for each row execute function public.touch_pulse_profile();

alter table public.medical_records enable row level security;
alter table public.conversations enable row level security;
revoke all on public.medical_records, public.conversations from anon;
grant select, insert, update, delete on public.medical_records, public.conversations to authenticated;

-- Use owner-only policies for each operation on both new tables.
do $$
declare t text;
begin
    foreach t in array array['medical_records', 'conversations'] loop
        execute format('drop policy if exists "Read own rows" on public.%I', t);
        execute format('create policy "Read own rows" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t);
        execute format('drop policy if exists "Insert own rows" on public.%I', t);
        execute format('create policy "Insert own rows" on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t);
        execute format('drop policy if exists "Update own rows" on public.%I', t);
        execute format('create policy "Update own rows" on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t);
        execute format('drop policy if exists "Delete own rows" on public.%I', t);
        execute format('create policy "Delete own rows" on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t);
    end loop;
end $$;
commit;
