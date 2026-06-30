-- ============================================================
-- ApiMonitor 数据库迁移：补齐 provider_preferences 等缺失的表和列
-- 在 Supabase Dashboard → SQL Editor 中执行此文件
-- ============================================================

-- 1. 创建 provider_preferences 表
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

-- 2. 给 provider_accounts 补充缺失列
alter table public.provider_accounts
  add column if not exists account_label text not null default '默认账号',
  add column if not exists is_archived boolean not null default false,
  add column if not exists credential_hint jsonb not null default '{}'::jsonb,
  add column if not exists last_test_at timestamptz,
  add column if not exists homepage_enabled boolean not null default false,
  add column if not exists homepage_order integer not null default 100,
  add column if not exists last_test_summary text;

-- 3. 将已有账号的 display_name 复制到 account_label
update public.provider_accounts
set account_label = display_name
where account_label = '默认账号' and display_name is not null and display_name != '';

-- 4. 创建 provider_account_credentials 表
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

-- 5. 索引
create unique index if not exists provider_accounts_user_id_idx
  on public.provider_accounts (user_id, id);
create index if not exists provider_preferences_user_order_idx
  on public.provider_preferences (user_id, display_order, provider_key);
create unique index if not exists provider_accounts_user_provider_label_idx
  on public.provider_accounts (user_id, provider_key, account_label);
create index if not exists provider_accounts_homepage_order_idx
  on public.provider_accounts (user_id, provider_key, homepage_enabled, homepage_order);

-- 6. RLS 策略
alter table public.provider_preferences enable row level security;
alter table public.provider_account_credentials enable row level security;

drop policy if exists provider_preferences_select_own on public.provider_preferences;
create policy provider_preferences_select_own
  on public.provider_preferences for select
  using ((select auth.uid()) = user_id);

drop policy if exists provider_preferences_insert_own on public.provider_preferences;
create policy provider_preferences_insert_own
  on public.provider_preferences for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists provider_preferences_update_own on public.provider_preferences;
create policy provider_preferences_update_own
  on public.provider_preferences for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists provider_preferences_delete_own on public.provider_preferences;
create policy provider_preferences_delete_own
  on public.provider_preferences for delete
  using ((select auth.uid()) = user_id);

-- 7. 权限
revoke all on public.provider_account_credentials from anon, authenticated;
grant select, insert, update, delete on public.provider_preferences to service_role;
grant select, insert, update, delete on public.provider_account_credentials to service_role;