-- OpenAI API 组织级快照：复用 usage_snapshots 表，补充专用查询索引与最小权限保护。
-- 先在测试/预发环境应用；线上启用 OpenAI API 卡片前必须应用本迁移。

-- 与 Worker 的 PostgREST 查询条件一致：payload->>resource / ->>periodStart 为文本比较。
create index if not exists usage_snapshots_openai_api_period_idx
  on public.usage_snapshots
  using btree (user_id, provider_key, (payload->>'resource'), (payload->>'periodStart'), captured_at desc)
  where provider_key = 'openai-api';

-- 既有 usage_snapshots_select_own / insert_own 对 authenticated 放行整表。
-- OpenAI API 是组织级数据，只允许 service_role（Worker）访问；浏览器角色不得直查。
drop policy if exists usage_snapshots_no_direct_openai_api_select on public.usage_snapshots;
create policy usage_snapshots_no_direct_openai_api_select
  on public.usage_snapshots
  as restrictive
  for select
  to authenticated, anon
  using (provider_key is distinct from 'openai-api');

drop policy if exists usage_snapshots_no_direct_openai_api_insert on public.usage_snapshots;
create policy usage_snapshots_no_direct_openai_api_insert
  on public.usage_snapshots
  as restrictive
  for insert
  to authenticated, anon
  with check (provider_key is distinct from 'openai-api');

drop policy if exists usage_snapshots_no_direct_openai_api_update on public.usage_snapshots;
create policy usage_snapshots_no_direct_openai_api_update
  on public.usage_snapshots
  as restrictive
  for update
  to authenticated, anon
  using (provider_key is distinct from 'openai-api')
  with check (provider_key is distinct from 'openai-api');

drop policy if exists usage_snapshots_no_direct_openai_api_delete on public.usage_snapshots;
create policy usage_snapshots_no_direct_openai_api_delete
  on public.usage_snapshots
  as restrictive
  for delete
  to authenticated, anon
  using (provider_key is distinct from 'openai-api');
