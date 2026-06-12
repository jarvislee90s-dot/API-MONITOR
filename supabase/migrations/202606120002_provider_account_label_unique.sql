drop index if exists public.provider_accounts_user_provider_label_idx;

with duplicate_provider_account_labels as (
  select
    id,
    row_number() over (
      partition by user_id, provider_key, account_label
      order by created_at, id
    ) as duplicate_index
  from public.provider_accounts
)
update public.provider_accounts as provider_account
set account_label = provider_account.account_label || ' ' || left(provider_account.id::text, 8)
from duplicate_provider_account_labels
where provider_account.id = duplicate_provider_account_labels.id
  and duplicate_provider_account_labels.duplicate_index > 1;

create unique index if not exists provider_accounts_user_provider_label_idx
  on public.provider_accounts (user_id, provider_key, account_label);
