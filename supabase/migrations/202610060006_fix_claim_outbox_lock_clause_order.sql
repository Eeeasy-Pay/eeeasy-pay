-- Forward-only defect fix (docs/implementation/DECISIONS.md ADR-009, OPEN_DECISIONS.md D-07).
-- Migration 202610060003 defined app_private.claim_outbox with its picking CTE written as
--   ORDER BY o.available_at, o.created_at
--   FOR UPDATE SKIP LOCKED
--   LIMIT p_limit
-- PostgreSQL requires LIMIT to precede the locking clause, so the function body fails
-- to parse at FIRST EXECUTION (plpgsql compiles bodies lazily), which is why the
-- migration still applied cleanly and the defect surfaced in the CI smoke run instead.
-- This migration replaces the function with the corrected clause order. Signature,
-- validation, lease contract, and grants are unchanged. Reviewed migrations 0001-0005
-- are untouched.

BEGIN;

CREATE OR REPLACE FUNCTION app_private.claim_outbox(p_worker text, p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 60)
RETURNS SETOF public.outbox_messages
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE v_lease_token uuid := gen_random_uuid();
BEGIN
  IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 120 OR p_limit NOT BETWEEN 1 AND 250
     OR p_lease_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'invalid outbox lease parameters' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH picked AS (
      SELECT o.outbox_message_id FROM public.outbox_messages o
      WHERE (o.state = 'pending' AND o.available_at <= now())
         OR (o.state = 'leased' AND o.lease_until < now())
      ORDER BY o.available_at, o.created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.outbox_messages o
       SET state = 'leased', lease_owner = p_worker, lease_token = v_lease_token,
           lease_until = now() + make_interval(secs => p_lease_seconds),
           attempts = o.attempts + 1
      FROM picked WHERE o.outbox_message_id = picked.outbox_message_id
    RETURNING o.*;
END;
$$;
REVOKE ALL ON FUNCTION app_private.claim_outbox(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.claim_outbox(text, integer, integer) TO service_role;

COMMIT;
