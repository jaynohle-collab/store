-- Isolated review snapshots only. No canonical job, evaluation, or application writes.
BEGIN;
CREATE TABLE IF NOT EXISTS keyword_review_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id text NOT NULL,
 snapshot jsonb NOT NULL,
 policy_version text NOT NULL,
 policy_fingerprint text NOT NULL,
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 seen_count integer NOT NULL DEFAULT 1 CHECK (seen_count > 0),
 UNIQUE (profile_id, id)
);
CREATE TABLE IF NOT EXISTS keyword_review_aliases (
 profile_id text NOT NULL,
 identity_key text NOT NULL,
 candidate_id uuid NOT NULL,
 PRIMARY KEY (profile_id, identity_key),
 FOREIGN KEY (profile_id, candidate_id) REFERENCES keyword_review_candidates(profile_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS keyword_review_observations (
 candidate_id uuid NOT NULL REFERENCES keyword_review_candidates(id) ON DELETE CASCADE,
 run_id uuid NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (candidate_id, run_id)
);
CREATE INDEX IF NOT EXISTS keyword_review_newest ON keyword_review_candidates(profile_id, first_seen_at DESC, id DESC);
-- One function call is an atomic transaction. Profile lock serializes alias merges.
CREATE OR REPLACE FUNCTION upsert_keyword_review(p_profile text, p_version text, p_fingerprint text, p_run uuid, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; alias jsonb; keys text[]; matches uuid[]; target uuid; other uuid;
 n_new integer := 0; n_updated integer := 0;
 created uuid[] := ARRAY[]::uuid[]; touched uuid[] := ARRAY[]::uuid[]; changed boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('keyword_review:' || p_profile, 0));
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  keys := ARRAY['url:' || encode(sha256(convert_to(r->>'normalized_url', 'UTF8')), 'hex')];
  IF coalesce(r->>'external_job_id','') <> '' THEN
   keys := array_append(keys, 'ats:' || encode(sha256(convert_to(jsonb_build_array(lower(trim(r->>'source')), lower(trim(r->>'company')), trim(r->>'external_job_id'))::text, 'UTF8')), 'hex'));
  END IF;
  FOR alias IN SELECT value FROM jsonb_array_elements(coalesce(r->'identity_aliases','[]'::jsonb)) LOOP
   keys := array_append(keys, 'url:' || encode(sha256(convert_to(alias->>'normalized_url', 'UTF8')), 'hex'));
   IF coalesce(alias->>'external_job_id','') <> '' THEN
    keys := array_append(keys, 'ats:' || encode(sha256(convert_to(jsonb_build_array(lower(trim(alias->>'source')), lower(trim(alias->>'company')), trim(alias->>'external_job_id'))::text, 'UTF8')), 'hex'));
   END IF;
  END LOOP;
  SELECT array_agg(c.id ORDER BY c.first_seen_at,c.id) INTO matches
  FROM keyword_review_candidates c WHERE c.profile_id=p_profile AND c.id IN
   (SELECT a.candidate_id FROM keyword_review_aliases a WHERE a.profile_id=p_profile AND a.identity_key=ANY(keys));
  target := matches[1];
  changed := true;
  IF target IS NULL THEN
   INSERT INTO keyword_review_candidates(profile_id,snapshot,policy_version,policy_fingerprint)
   VALUES(p_profile,r,p_version,p_fingerprint) RETURNING id INTO target;
   created := array_append(created,target);
  ELSE
   SELECT snapshot IS DISTINCT FROM r OR policy_version IS DISTINCT FROM p_version OR policy_fingerprint IS DISTINCT FROM p_fingerprint
    OR NOT EXISTS (SELECT 1 FROM keyword_review_observations WHERE candidate_id=target AND run_id=p_run)
    OR cardinality(matches)>1 INTO changed FROM keyword_review_candidates WHERE id=target;
   IF changed THEN touched := array_append(touched,target); END IF;
   -- Merge previously separate identities when a later row proves equivalence.
   FOREACH other IN ARRAY matches LOOP
    IF other <> target THEN
     INSERT INTO keyword_review_observations(candidate_id,run_id,observed_at)
      SELECT target,run_id,observed_at FROM keyword_review_observations WHERE candidate_id=other
      ON CONFLICT(candidate_id,run_id) DO UPDATE SET observed_at=least(keyword_review_observations.observed_at,excluded.observed_at);
     UPDATE keyword_review_aliases SET candidate_id=target WHERE candidate_id=other;
     UPDATE keyword_review_candidates SET first_seen_at=least(first_seen_at,(SELECT first_seen_at FROM keyword_review_candidates WHERE id=other)),
      last_seen_at=greatest(last_seen_at,(SELECT last_seen_at FROM keyword_review_candidates WHERE id=other)) WHERE id=target;
     DELETE FROM keyword_review_candidates WHERE id=other;
    END IF;
   END LOOP;
  END IF;
  INSERT INTO keyword_review_aliases(profile_id,identity_key,candidate_id)
   SELECT p_profile,k,target FROM unnest(keys) k ON CONFLICT DO NOTHING;
  INSERT INTO keyword_review_observations(candidate_id,run_id) VALUES(target,p_run) ON CONFLICT DO NOTHING;
  UPDATE keyword_review_candidates SET snapshot=r, policy_version=p_version, policy_fingerprint=p_fingerprint,
   last_seen_at=CASE WHEN changed THEN greatest(last_seen_at,now()) ELSE last_seen_at END, seen_count=(SELECT count(*) FROM keyword_review_observations WHERE candidate_id=target)
   WHERE id=target;

 END LOOP;
 SELECT count(*) INTO n_new FROM keyword_review_candidates WHERE id=ANY(created);
 SELECT count(*) INTO n_updated FROM keyword_review_candidates WHERE id=ANY(touched) AND NOT id=ANY(created);
 RETURN jsonb_build_object('saved_count',jsonb_array_length(p_rows),'new_count',n_new,'updated_count',n_updated);
END;
$$;
COMMIT;
