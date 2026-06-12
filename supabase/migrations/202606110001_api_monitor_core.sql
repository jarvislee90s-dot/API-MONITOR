create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.provider_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_key text not null,
  display_name text not null,
  source_url text not null,
  auth_mode text not null default 'unknown',
  status text not null default 'unknown',
  status_message text,
  config jsonb not null default '{}'::jsonb,
  secret_ref text,
  last_refresh_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists provider_accounts_user_provider_source_idx
  on public.provider_accounts (user_id, provider_key, source_url);

create index if not exists provider_accounts_user_status_idx
  on public.provider_accounts (user_id, status);

drop trigger if exists set_provider_accounts_updated_at on public.provider_accounts;
create trigger set_provider_accounts_updated_at
before update on public.provider_accounts
for each row execute function public.set_updated_at();

create table if not exists public.usage_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_account_id uuid references public.provider_accounts(id) on delete set null,
  provider_key text not null,
  captured_at timestamptz not null,
  status text not null,
  summary text not null,
  source_url text not null,
  payload jsonb not null default '{}'::jsonb,
  raw_payload jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists usage_snapshots_user_provider_captured_idx
  on public.usage_snapshots (user_id, provider_key, captured_at desc);

create index if not exists usage_snapshots_provider_account_captured_idx
  on public.usage_snapshots (provider_account_id, captured_at desc);

create table if not exists public.quota_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_account_id uuid references public.provider_accounts(id) on delete set null,
  snapshot_id uuid references public.usage_snapshots(id) on delete cascade,
  provider_key text not null,
  window_key text not null,
  window_label text not null,
  used_value numeric,
  limit_value numeric,
  remaining_value numeric,
  percent_used numeric,
  percent_remaining numeric,
  reset_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists quota_windows_snapshot_idx
  on public.quota_windows (snapshot_id);

create index if not exists quota_windows_user_provider_window_idx
  on public.quota_windows (user_id, provider_key, window_key);

create table if not exists public.model_usage_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_account_id uuid references public.provider_accounts(id) on delete set null,
  snapshot_id uuid references public.usage_snapshots(id) on delete set null,
  provider_key text not null,
  usage_date date not null,
  model_name text not null,
  request_count integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_amount numeric(18,6) not null default 0,
  currency text not null default 'USD',
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists model_usage_daily_user_provider_date_idx
  on public.model_usage_daily (user_id, provider_key, usage_date desc);

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
