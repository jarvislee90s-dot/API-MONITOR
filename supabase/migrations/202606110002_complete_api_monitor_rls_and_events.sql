create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.refresh_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_account_id uuid references public.provider_accounts(id) on delete set null,
  provider_key text not null,
  session_key text not null,
  event_type text not null,
  status text not null,
  message text,
  details jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists refresh_events_user_provider_requested_idx
  on public.refresh_events (user_id, provider_key, requested_at desc);

create index if not exists refresh_events_session_idx
  on public.refresh_events (session_key, requested_at desc);

create index if not exists quota_windows_provider_account_idx
  on public.quota_windows (provider_account_id);

create index if not exists model_usage_daily_provider_account_idx
  on public.model_usage_daily (provider_account_id);

create index if not exists model_usage_daily_snapshot_idx
  on public.model_usage_daily (snapshot_id);

alter table public.provider_accounts enable row level security;
alter table public.usage_snapshots enable row level security;
alter table public.quota_windows enable row level security;
alter table public.model_usage_daily enable row level security;
alter table public.refresh_events enable row level security;

drop policy if exists provider_accounts_select_own on public.provider_accounts;
create policy provider_accounts_select_own
  on public.provider_accounts
  for select
  using (auth.uid() = user_id);

drop policy if exists provider_accounts_insert_own on public.provider_accounts;
create policy provider_accounts_insert_own
  on public.provider_accounts
  for insert
  with check (auth.uid() = user_id);

drop policy if exists provider_accounts_update_own on public.provider_accounts;
create policy provider_accounts_update_own
  on public.provider_accounts
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists usage_snapshots_select_own on public.usage_snapshots;
create policy usage_snapshots_select_own
  on public.usage_snapshots
  for select
  using (auth.uid() = user_id);

drop policy if exists usage_snapshots_insert_own on public.usage_snapshots;
create policy usage_snapshots_insert_own
  on public.usage_snapshots
  for insert
  with check (auth.uid() = user_id);

drop policy if exists quota_windows_select_own on public.quota_windows;
create policy quota_windows_select_own
  on public.quota_windows
  for select
  using (auth.uid() = user_id);

drop policy if exists quota_windows_insert_own on public.quota_windows;
create policy quota_windows_insert_own
  on public.quota_windows
  for insert
  with check (auth.uid() = user_id);

drop policy if exists model_usage_daily_select_own on public.model_usage_daily;
create policy model_usage_daily_select_own
  on public.model_usage_daily
  for select
  using (auth.uid() = user_id);

drop policy if exists model_usage_daily_insert_own on public.model_usage_daily;
create policy model_usage_daily_insert_own
  on public.model_usage_daily
  for insert
  with check (auth.uid() = user_id);

drop policy if exists refresh_events_select_own on public.refresh_events;
create policy refresh_events_select_own
  on public.refresh_events
  for select
  using (auth.uid() = user_id);

drop policy if exists refresh_events_insert_own on public.refresh_events;
create policy refresh_events_insert_own
  on public.refresh_events
  for insert
  with check (auth.uid() = user_id);
