-- CI / disposable-local-database fixture ONLY.
-- Synthesizes the auth schema and roles that Supabase provides in managed environments.
-- NEVER run this against a real or shared environment (see docs/implementation/GUARDRAILS.md).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;

-- Managed Supabase grants service_role BYPASSRLS; the reviewed migrations grant
-- service_role direct table access alongside RLS policies on the assumption that it
-- bypasses RLS (the real role does). Mirror that here so the fixture behaves like the
-- managed environment for the persistence integration tests (ADR-016).
ALTER ROLE service_role BYPASSRLS;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON auth.users TO service_role;

-- Test harness impersonates a user by setting request.jwt.claim.sub, like Supabase does.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

COMMIT;
