alter table public.provider_accounts
  add column if not exists homepage_enabled boolean not null default false,
  add column if not exists homepage_order integer not null default 100,
  add column if not exists last_test_summary text;

create index if not exists provider_accounts_homepage_order_idx
  on public.provider_accounts (user_id, provider_key, homepage_enabled, homepage_order);
