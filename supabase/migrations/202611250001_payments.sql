-- Stocky History Rescue: payment/license metadata only. Never store imported data.
-- Apply with the Supabase migration owner. Runtime access is service_role only.
create table public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('test', 'live')),
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  email text not null check (length(email) between 3 and 254 and email = lower(email)),
  amount integer not null default 1900 check (amount = 1900),
  currency text not null default 'USD' check (currency = 'USD'),
  razorpay_order_id text,
  status text not null default 'creating' check (status in ('creating', 'pending', 'paid', 'revoked')),
  session_expires_at timestamptz not null default (now() + interval '90 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(mode, token_hash),
  unique(mode, razorpay_order_id)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  checkout_session_id uuid not null references public.checkout_sessions(id),
  mode text not null check (mode in ('test', 'live')),
  razorpay_payment_id text not null,
  razorpay_order_id text not null,
  amount integer not null check (amount = 1900),
  currency text not null check (currency = 'USD'),
  status text not null check (status in ('authorized', 'captured', 'failed', 'refunded', 'disputed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(mode, razorpay_payment_id)
);

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  checkout_session_id uuid not null unique references public.checkout_sessions(id),
  payment_id uuid not null unique references public.payments(id),
  mode text not null check (mode in ('test', 'live')),
  product text not null default 'stocky-history-rescue' check (product = 'stocky-history-rescue'),
  merchant_limit integer not null default 1 check (merchant_limit = 1),
  status text not null check (status in ('active', 'refunded', 'disputed')),
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.webhook_events (
  mode text not null check (mode in ('test', 'live')),
  event_id text not null check (length(event_id) between 1 and 200),
  event_type text not null check (length(event_type) between 1 and 100),
  body_hash text not null check (body_hash ~ '^[a-f0-9]{64}$'),
  processed_at timestamptz not null default now(),
  primary key(mode, event_id)
);

create table public.license_recovery_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  entitlement_id uuid not null references public.entitlements(id),
  mode text not null check (mode in ('test', 'live')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.payment_rate_limits (
  key_hash text not null check (length(key_hash) between 1 and 200),
  bucket_start timestamptz not null,
  hits integer not null check (hits > 0),
  primary key (key_hash, bucket_start)
);

create index checkout_sessions_recovery on public.checkout_sessions(mode, email, created_at desc);
create index payments_session on public.payments(checkout_session_id);
create index license_recovery_entitlement on public.license_recovery_tokens(entitlement_id);
create index payment_rate_limits_expiry on public.payment_rate_limits(bucket_start);

alter table public.checkout_sessions enable row level security;
alter table public.payments enable row level security;
alter table public.entitlements enable row level security;
alter table public.webhook_events enable row level security;
alter table public.license_recovery_tokens enable row level security;
alter table public.payment_rate_limits enable row level security;

revoke all on public.checkout_sessions, public.payments, public.entitlements,
  public.webhook_events, public.license_recovery_tokens, public.payment_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.checkout_sessions, public.payments, public.entitlements,
  public.webhook_events, public.license_recovery_tokens, public.payment_rate_limits to service_role;

-- The token is generated server-side; only its peppered HMAC-SHA-256 is stored.
-- The row insertion is the create-order lease. An uncertain provider response
-- must be reconciled by receipt (shr_ + UUID without hyphens), never retried blindly.
create function public.shr_reserve_checkout(p_mode text, p_token_hash text, p_email text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.checkout_sessions; e public.entitlements; inserted boolean := false;
begin
  insert into public.checkout_sessions(mode, token_hash, email)
    values (p_mode, p_token_hash, p_email) on conflict(mode, token_hash) do nothing returning * into s;
  if s.id is not null then inserted := true;
  else
    select * into s from public.checkout_sessions where mode = p_mode and token_hash = p_token_hash for update;
    if s.email <> p_email then raise exception 'checkout_email_mismatch'; end if;
    if s.session_expires_at <= now() then raise exception 'checkout_session_expired'; end if;
  end if;
  select * into e from public.entitlements where checkout_session_id = s.id;
  return jsonb_build_object('session', to_jsonb(s) || jsonb_build_object('entitlement_status', e.status, 'entitlement_id', e.id), 'created', inserted);
end $$;

create function public.shr_save_order(p_session_id uuid, p_mode text, p_order_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.checkout_sessions;
begin
  if p_order_id !~ '^order_[A-Za-z0-9]+$' then raise exception 'invalid_order_id'; end if;
  select * into s from public.checkout_sessions where id = p_session_id and mode = p_mode for update;
  if s.id is null then raise exception 'unknown_checkout'; end if;
  if s.razorpay_order_id is not null and s.razorpay_order_id <> p_order_id then raise exception 'checkout_order_conflict'; end if;
  update public.checkout_sessions set razorpay_order_id = p_order_id,
    status = case when status = 'creating' then 'pending' else status end, updated_at = now()
    where id = s.id returning * into s;
  return to_jsonb(s);
end $$;

create function public.shr_get_session(p_mode text, p_token_hash text)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select to_jsonb(s) || jsonb_build_object('entitlement_status', e.status, 'entitlement_id', e.id)
  from public.checkout_sessions s left join public.entitlements e on e.checkout_session_id = s.id
  where s.mode = p_mode and s.token_hash = p_token_hash and s.session_expires_at > now()
$$;

create function public.shr_find_order(p_mode text, p_order_id text)
returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select to_jsonb(s) from public.checkout_sessions s where s.mode = p_mode and s.razorpay_order_id = p_order_id
$$;

-- Signature verification and provider API checks happen in server code before
-- calling this function. State, event deduplication and license grant are one
-- transaction. Failure rolls back the event receipt so Razorpay can retry.
create function public.shr_apply_payment(
  p_mode text, p_order_id text, p_payment_id text, p_status text, p_amount integer, p_currency text,
  p_event_id text default null, p_event_type text default null, p_body_hash text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.checkout_sessions; pay public.payments; ev public.webhook_events;
  ent public.entitlements; next_status text; duplicate boolean := false;
begin
  if p_mode not in ('test', 'live') or p_amount <> 1900 or p_currency <> 'USD' then raise exception 'payment_amount_mismatch'; end if;
  if p_payment_id !~ '^pay_[A-Za-z0-9]+$' or p_order_id !~ '^order_[A-Za-z0-9]+$'
    or p_status not in ('authorized', 'captured', 'failed', 'refunded', 'disputed') then raise exception 'invalid_payment'; end if;
  select * into s from public.checkout_sessions where mode = p_mode and razorpay_order_id = p_order_id for update;
  if s.id is null then raise exception 'unknown_checkout_order'; end if;
  if s.amount <> p_amount or s.currency <> p_currency then raise exception 'payment_amount_mismatch'; end if;
  if p_event_id is not null then
    insert into public.webhook_events(mode, event_id, event_type, body_hash)
      values (p_mode, p_event_id, p_event_type, p_body_hash) on conflict do nothing returning * into ev;
    if ev.event_id is null then
      select * into ev from public.webhook_events where mode = p_mode and event_id = p_event_id;
      if ev.body_hash <> p_body_hash or ev.event_type <> p_event_type then raise exception 'webhook_event_conflict'; end if;
      duplicate := true;
    end if;
  end if;
  if not duplicate then
    select * into pay from public.payments where mode = p_mode and razorpay_payment_id = p_payment_id for update;
    if pay.id is not null and (pay.checkout_session_id <> s.id or pay.razorpay_order_id <> p_order_id or pay.amount <> p_amount or pay.currency <> p_currency) then
      raise exception 'payment_replay_conflict';
    end if;
    -- Refund/dispute states are terminal for automatic granting. A won dispute
    -- needs an explicit operator review; stale captured events never restore it.
    next_status := case
      when pay.status = 'refunded' or p_status = 'refunded' then 'refunded'
      when pay.status = 'disputed' or p_status = 'disputed' then 'disputed'
      when pay.status = 'captured' or p_status = 'captured' then 'captured'
      when pay.status = 'authorized' and p_status = 'failed' then 'failed'
      else p_status end;
    insert into public.payments(checkout_session_id, mode, razorpay_payment_id, razorpay_order_id, amount, currency, status)
      values(s.id, p_mode, p_payment_id, p_order_id, p_amount, p_currency, next_status)
      on conflict(mode, razorpay_payment_id) do update set status = excluded.status, updated_at = now()
      where payments.checkout_session_id = excluded.checkout_session_id and payments.razorpay_order_id = excluded.razorpay_order_id
        and payments.amount = excluded.amount and payments.currency = excluded.currency
      returning * into pay;
    if pay.id is null then raise exception 'payment_replay_conflict'; end if;
    if next_status in ('refunded', 'disputed') then
      update public.checkout_sessions set status = 'revoked', updated_at = now() where id = s.id;
      update public.entitlements set status = case when status = 'refunded' then status else next_status end, updated_at = now() where checkout_session_id = s.id;
    elsif next_status = 'captured' and s.status <> 'revoked' then
      insert into public.entitlements(checkout_session_id, payment_id, mode, status)
        values(s.id, pay.id, p_mode, 'active') on conflict(checkout_session_id) do nothing;
      update public.checkout_sessions set status = 'paid', updated_at = now() where id = s.id;
    end if;
  end if;
  select * into ent from public.entitlements where checkout_session_id = s.id;
  return jsonb_build_object('duplicate', duplicate, 'entitlement_status', ent.status, 'entitlement_id', ent.id);
end $$;

create function public.shr_issue_recovery(p_mode text, p_email text, p_token_hash text, p_expires_at timestamptz, p_order_id text default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare target_entitlement_id uuid; target_session_id uuid;
begin
  if p_expires_at <= now() or p_expires_at > now() + interval '30 minutes' then raise exception 'invalid_recovery_expiry'; end if;
  select e.id, s.id into target_entitlement_id, target_session_id from public.entitlements e join public.checkout_sessions s on s.id = e.checkout_session_id
    where s.mode = p_mode and s.email = p_email and e.status = 'active' and (p_order_id is null or s.razorpay_order_id = p_order_id)
    order by e.granted_at desc, e.id desc limit 1 for update of s;
  if target_entitlement_id is null then return false; end if;
  if not exists(select 1 from public.entitlements where id = target_entitlement_id and status = 'active') then return false; end if;
  delete from public.license_recovery_tokens where entitlement_id = target_entitlement_id;
  insert into public.license_recovery_tokens(token_hash, entitlement_id, mode, expires_at)
    values(p_token_hash, target_entitlement_id, p_mode, p_expires_at);
  return true;
end $$;

create function public.shr_redeem_recovery(p_mode text, p_token_hash text, p_new_session_hash text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.license_recovery_tokens; e public.entitlements; s public.checkout_sessions;
begin
  select * into t from public.license_recovery_tokens where token_hash = p_token_hash and mode = p_mode;
  if t.token_hash is null or t.used_at is not null or t.expires_at <= now() then return null; end if;
  select * into e from public.entitlements where id = t.entitlement_id;
  select * into s from public.checkout_sessions where id = e.checkout_session_id for update;
  select * into t from public.license_recovery_tokens where token_hash = p_token_hash and mode = p_mode for update;
  if t.token_hash is null or t.used_at is not null or t.expires_at <= now() then return null; end if;
  select * into e from public.entitlements where id = t.entitlement_id;
  if e.status <> 'active' then return null; end if;
  if s.status <> 'paid' then return null; end if;
  update public.checkout_sessions set token_hash = p_new_session_hash, session_expires_at = now() + interval '90 days', updated_at = now()
    where id = s.id returning * into s;
  update public.license_recovery_tokens set used_at = now() where token_hash = p_token_hash;
  return to_jsonb(s) || jsonb_build_object('entitlement_status', e.status, 'entitlement_id', e.id);
end $$;

create function public.shr_rate_limit(p_key_hash text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare bucket timestamptz; hit_count integer;
begin
  if p_limit < 1 or p_limit > 10000 or p_window_seconds < 1 or p_window_seconds > 86400 then raise exception 'invalid_rate_limit'; end if;
  bucket := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  delete from public.payment_rate_limits where bucket_start < now() - interval '2 days';
  insert into public.payment_rate_limits(key_hash, bucket_start, hits) values (p_key_hash, bucket, 1)
    on conflict(key_hash, bucket_start) do update set hits = least(public.payment_rate_limits.hits + 1, 10001)
    returning hits into hit_count;
  return hit_count <= p_limit;
end $$;

-- PostgreSQL grants function EXECUTE to PUBLIC unless explicitly revoked.
revoke all on function public.shr_reserve_checkout(text,text,text), public.shr_save_order(uuid,text,text),
 public.shr_get_session(text,text), public.shr_find_order(text,text),
 public.shr_apply_payment(text,text,text,text,integer,text,text,text,text),
 public.shr_issue_recovery(text,text,text,timestamptz,text), public.shr_redeem_recovery(text,text,text),
 public.shr_rate_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.shr_reserve_checkout(text,text,text), public.shr_save_order(uuid,text,text),
 public.shr_get_session(text,text), public.shr_find_order(text,text),
 public.shr_apply_payment(text,text,text,text,integer,text,text,text,text),
 public.shr_issue_recovery(text,text,text,timestamptz,text), public.shr_redeem_recovery(text,text,text),
 public.shr_rate_limit(text,integer,integer) to service_role;
