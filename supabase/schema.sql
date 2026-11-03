create table if not exists public.browser_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  bookmarks jsonb not null default '[]'::jsonb check (jsonb_typeof(bookmarks) = 'array'),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.browser_data enable row level security;

revoke all on public.browser_data from anon;
grant select, insert, update on public.browser_data to authenticated;

drop policy if exists "Users can read their own browser data" on public.browser_data;
drop policy if exists "Users can create their own browser data" on public.browser_data;
drop policy if exists "Users can update their own browser data" on public.browser_data;

create policy "Users can read their own browser data"
  on public.browser_data for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own browser data"
  on public.browser_data for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own browser data"
  on public.browser_data for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
