-- 014: enable companies pre-registered (disabled) by migration 010, per owner decision 2026-10-25.
-- OpenAI, Netflix and Shopify stay disabled. Idempotent; touches only the enabled flag.
BEGIN;

UPDATE discovery_companies
SET enabled = TRUE, updated_at = NOW()
WHERE company_key IN ('stripe', 'notion', 'figma', 'airbnb', 'datadog', 'cloudflare', 'ramp')
  AND enabled = FALSE;

COMMIT;
