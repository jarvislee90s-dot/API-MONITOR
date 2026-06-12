create index if not exists refresh_events_provider_account_idx
  on public.refresh_events (provider_account_id);

revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.rls_auto_enable() from anon;
revoke execute on function public.rls_auto_enable() from authenticated;

drop policy if exists provider_accounts_select_own on public.provider_accounts;
create policy provider_accounts_select_own
  on public.provider_accounts
  for select
  using ((select auth.uid()) = user_id);

drop policy if exists provider_accounts_insert_own on public.provider_accounts;
create policy provider_accounts_insert_own
  on public.provider_accounts
  for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists provider_accounts_update_own on public.provider_accounts;
create policy provider_accounts_update_own
  on public.provider_accounts
  for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists usage_snapshots_select_own on public.usage_snapshots;
create policy usage_snapshots_select_own
  on public.usage_snapshots
  for select
  using ((select auth.uid()) = user_id);

drop policy if exists usage_snapshots_insert_own on public.usage_snapshots;
create policy usage_snapshots_insert_own
  on public.usage_snapshots
  for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists quota_windows_select_own on public.quota_windows;
create policy quota_windows_select_own
  on public.quota_windows
  for select
  using ((select auth.uid()) = user_id);

drop policy if exists quota_windows_insert_own on public.quota_windows;
create policy quota_windows_insert_own
  on public.quota_windows
  for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists model_usage_daily_select_own on public.model_usage_daily;
create policy model_usage_daily_select_own
  on public.model_usage_daily
  for select
  using ((select auth.uid()) = user_id);

drop policy if exists model_usage_daily_insert_own on public.model_usage_daily;
create policy model_usage_daily_insert_own
  on public.model_usage_daily
  for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists refresh_events_select_own on public.refresh_events;
create policy refresh_events_select_own
  on public.refresh_events
  for select
  using ((select auth.uid()) = user_id);

drop policy if exists refresh_events_insert_own on public.refresh_events;
create policy refresh_events_insert_own
  on public.refresh_events
  for insert
  with check ((select auth.uid()) = user_id);
