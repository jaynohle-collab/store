-- Disabled unless the application runtime explicitly enables reviewed controls.
-- Application allowance only, not an invoice/provider-account spending cap.
-- SECURITY INVOKER: backend role only; never grant tables/functions to clients.
CREATE TABLE haiku_budget_lock (id integer PRIMARY KEY CHECK (id = 1));
INSERT INTO haiku_budget_lock VALUES (1);
CREATE TABLE haiku_daily_budget (
  budget_day date PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 50)
);
CREATE TABLE haiku_monthly_budget (
  budget_month date PRIMARY KEY,
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd BETWEEN 0 AND 30000000)
);
CREATE TABLE haiku_attempt_reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_identity text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  budget_day date NOT NULL REFERENCES haiku_daily_budget,
  budget_month date NOT NULL REFERENCES haiku_monthly_budget,
  reserved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  dispatch_before timestamptz,
  CHECK (expires_at > reserved_at)
);

CREATE FUNCTION reserve_haiku_attempt(p_owner text, p_monthly_limit bigint, p_digest text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  ts timestamptz; d date; m date; reset_ts timestamptz;
  n integer; cost bigint; rid uuid; expiry timestamptz; reason text;
BEGIN
  -- Serialize across workers and take database time AFTER any lock wait.
  PERFORM id FROM haiku_budget_lock WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'budget lock missing'; END IF;
  ts := clock_timestamp();
  d := (ts AT TIME ZONE 'America/Los_Angeles')::date;
  m := date_trunc('month', d)::date;
  reset_ts := (d + 1)::timestamp AT TIME ZONE 'America/Los_Angeles';
  INSERT INTO haiku_daily_budget VALUES (d, 0) ON CONFLICT DO NOTHING;
  INSERT INTO haiku_monthly_budget VALUES (m, 0) ON CONFLICT DO NOTHING;
  SELECT attempts INTO n FROM haiku_daily_budget WHERE budget_day = d FOR UPDATE;
  SELECT reserved_micro_usd INTO cost FROM haiku_monthly_budget WHERE budget_month = m FOR UPDATE;
  IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN reason := 'invalid_digest';
  ELSIF p_owner IS NULL OR length(trim(p_owner)) = 0 THEN reason := 'missing_identity';
  ELSIF p_monthly_limit IS NULL OR p_monthly_limit < 5000 OR p_monthly_limit > 30000000 THEN reason := 'disabled';
  ELSIF reset_ts - ts <= interval '10 seconds' THEN reason := 'day_reset_pending';
  ELSIF n >= 50 THEN reason := 'daily_limit';
  ELSIF cost + 5000 > p_monthly_limit THEN reason := 'monthly_limit';
  ELSE
    n := n + 1;
    UPDATE haiku_daily_budget SET attempts = n WHERE budget_day = d;
    UPDATE haiku_monthly_budget SET reserved_micro_usd = cost + 5000 WHERE budget_month = m;
    expiry := LEAST(ts + interval '60 seconds', reset_ts - interval '10 seconds');
    INSERT INTO haiku_attempt_reservations(owner_identity, request_sha256, budget_day, budget_month, reserved_at, expires_at)
      VALUES (p_owner, p_digest, d, m, ts, expiry) RETURNING reservation_id INTO rid;
    reason := 'reserved';
  END IF;
  RETURN jsonb_build_object('allowed', rid IS NOT NULL, 'reason', reason,
    'reservation_id', rid, 'expires_at', expiry, 'reset_at', reset_ts,
    'budget_day', d, 'used', n, 'remaining', 50-n);
END;
$$;

CREATE FUNCTION claim_haiku_attempt(p_owner text, p_reservation uuid, p_digest text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r haiku_attempt_reservations%ROWTYPE; ts timestamptz; deadline timestamptz;
BEGIN
  SELECT * INTO r FROM haiku_attempt_reservations WHERE reservation_id = p_reservation FOR UPDATE;
  ts := clock_timestamp();
  IF NOT FOUND OR r.owner_identity IS DISTINCT FROM p_owner OR r.request_sha256 IS DISTINCT FROM p_digest OR r.claimed_at IS NOT NULL
    OR r.expires_at <= ts OR r.budget_day <> (ts AT TIME ZONE 'America/Los_Angeles')::date
    OR ((r.budget_day + 1)::timestamp AT TIME ZONE 'America/Los_Angeles') - ts <= interval '10 seconds' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_expired_or_used', 'dispatch_before', NULL);
  END IF;
  deadline := LEAST(ts + interval '5 seconds', r.expires_at);
  UPDATE haiku_attempt_reservations SET claimed_at = ts, dispatch_before = deadline WHERE reservation_id = p_reservation;
  RETURN jsonb_build_object('allowed', true, 'reason', 'claimed', 'reservation_id', p_reservation,
    'dispatch_before', deadline, 'server_time', ts, 'expires_at', r.expires_at,
    'reset_at', (r.budget_day + 1)::timestamp AT TIME ZONE 'America/Los_Angeles', 'model', 'claude-haiku-5-5', 'max_request_bytes', 16000,
    'max_output_tokens', 2048, 'reserved_micro_usd', 5000, 'policy_version', 'haiku-5-5-v1');
END;
$$;
REVOKE ALL ON FUNCTION reserve_haiku_attempt(text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_haiku_attempt(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON haiku_budget_lock, haiku_daily_budget, haiku_monthly_budget, haiku_attempt_reservations FROM PUBLIC;
