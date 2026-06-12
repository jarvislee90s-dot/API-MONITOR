create table if not exists public.provider_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_key text not null,
  enabled boolean not null default true,
  display_order integer not null default 100,
  active_provider_account_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider_key)
);

alter table public.provider_accounts
  add column if not exists account_label text not null default '默认账号',
  add column if not exists is_archived boolean not null default false,
  add column if not exists credential_hint jsonb not null default '{}'::jsonb,
  add column if not exists last_test_at timestamptz;

create table if not exists public.provider_account_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_account_id uuid not null,
  encrypted_payload text not null,
  nonce text not null,
  key_version text not null default 'v1',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (provider_account_id)
);

create unique index if not exists provider_accounts_user_id_idx
  on public.provider_accounts (user_id, id);

create index if not exists provider_preferences_user_order_idx
  on public.provider_preferences (user_id, display_order, provider_key);

create index if not exists provider_accounts_user_provider_label_idx
  on public.provider_accounts (user_id, provider_key, account_label);

alter table public.provider_preferences
  drop constraint if exists provider_preferences_active_account_same_user_fk;

alter table public.provider_preferences
  add constraint provider_preferences_active_account_same_user_fk
  foreign key (user_id, active_provider_account_id)
  references public.provider_accounts (user_id, id)
  on delete set null (active_provider_account_id);

alter table public.provider_account_credentials
  drop constraint if exists provider_account_credentials_account_same_user_fk;

alter table public.provider_account_credentials
  add constraint provider_account_credentials_account_same_user_fk
  foreign key (user_id, provider_account_id)
  references public.provider_accounts (user_id, id)
  on delete cascade;

alter table public.provider_preferences enable row level security;
alter table public.provider_account_credentials enable row level security;

drop policy if exists provider_preferences_select_own on public.provider_preferences;
create policy provider_preferences_select_own
  on public.provider_preferences
  for select
  using ((select auth.uid()) = user_id);

drop policy if exists provider_preferences_insert_own on public.provider_preferences;
create policy provider_preferences_insert_own
  on public.provider_preferences
  for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists provider_preferences_update_own on public.provider_preferences;
create policy provider_preferences_update_own
  on public.provider_preferences
  for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists provider_preferences_delete_own on public.provider_preferences;
create policy provider_preferences_delete_own
  on public.provider_preferences
  for delete
  using ((select auth.uid()) = user_id);

revoke all on public.provider_account_credentials from anon, authenticated;
grant select, insert, update, delete on public.provider_account_credentials to service_role;
