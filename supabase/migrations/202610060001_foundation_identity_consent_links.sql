-- 202610060001_foundation_identity_consent_links.sql
-- Supabase/PostgreSQL product-data foundation only. Never a bank or Mojaloop ledger.
-- Requires the standard Supabase auth schema/roles (auth.users, anon, authenticated, service_role).
BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA app_private TO service_role;

CREATE TYPE public.consent_action AS ENUM ('granted', 'revoked');
CREATE TYPE public.phone_verification_state AS ENUM ('pending', 'verified', 'suspended', 'removed');
CREATE TYPE public.alias_projection_state AS ENUM ('pending', 'active', 'suspended', 'disassociated', 'expired', 'conflict');
CREATE TYPE public.bank_link_state AS ENUM ('pending', 'verified', 'active', 'suspended', 'removed');

CREATE OR REPLACE FUNCTION app_private.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.touch_updated_at() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'append-only record cannot be changed' USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION app_private.reject_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  display_name text CHECK (display_name IS NULL OR length(display_name) <= 100),
  locale_tag text CHECK (locale_tag IS NULL OR length(locale_tag) <= 35),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER profiles_touch_updated_at BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_read_own ON public.profiles FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.profiles FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (user_id, display_name, locale_tag, created_at, updated_at) ON public.profiles TO authenticated;
GRANT UPDATE (display_name, locale_tag) ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO service_role;

-- Consent is a versioned event stream; no speculative legal/regulatory attributes are modeled.
CREATE TABLE public.consent_events (
  consent_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  consent_key text NOT NULL CHECK (consent_key ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  document_version text NOT NULL CHECK (length(document_version) BETWEEN 1 AND 80),
  action public.consent_action NOT NULL,
  channel text NOT NULL CHECK (channel IN ('mobile', 'web', 'support', 'partner_api')),
  content_sha256 bytea CHECK (content_sha256 IS NULL OR octet_length(content_sha256) = 32),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  idempotency_ref uuid UNIQUE
);
CREATE INDEX consent_events_user_time_idx ON public.consent_events(user_id, recorded_at DESC);
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON public.consent_events
FOR EACH ROW EXECUTE FUNCTION app_private.reject_mutation();
ALTER TABLE public.consent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_events_read_own ON public.consent_events FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.consent_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (consent_event_id, user_id, consent_key, document_version, action, channel, recorded_at)
  ON public.consent_events TO authenticated;
GRANT SELECT, INSERT ON public.consent_events TO service_role;

-- Phone values are represented only by an application-keyed token/HMAC plus a key version.
-- Raw phone numbers and address-book values do not belong in this schema.
CREATE TABLE public.verified_phones (
  verified_phone_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  phone_token bytea NOT NULL CHECK (octet_length(phone_token) = 32),
  token_key_version smallint NOT NULL CHECK (token_key_version > 0),
  verification_state public.phone_verification_state NOT NULL DEFAULT 'pending',
  verification_method text NOT NULL CHECK (verification_method IN ('sms_otp', 'partner_assertion', 'other_approved')),
  verified_at timestamptz,
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (verification_state <> 'verified' OR verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX verified_phones_one_active_token_idx ON public.verified_phones(phone_token)
  WHERE verification_state = 'verified';
CREATE INDEX verified_phones_user_idx ON public.verified_phones(user_id, created_at DESC);
CREATE TRIGGER verified_phones_touch_updated_at BEFORE UPDATE ON public.verified_phones
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
ALTER TABLE public.verified_phones ENABLE ROW LEVEL SECURITY;
CREATE POLICY verified_phones_read_own ON public.verified_phones FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.verified_phones FROM PUBLIC, anon, authenticated, service_role;
-- No token/evidence columns are exposed to the client; status-only reads can be added via a narrow view later.
GRANT SELECT (verified_phone_id, user_id, verification_state, verified_at, created_at) ON public.verified_phones TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.verified_phones TO service_role;

-- This is a projection of participant/DFSP-confirmed association, not a scheme registry or oracle.
CREATE TABLE public.alias_associations (
  alias_association_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verified_phone_id uuid REFERENCES public.verified_phones(verified_phone_id) ON DELETE RESTRICT,
  alias_type text NOT NULL CHECK (alias_type ~ '^[a-z][a-z0-9_-]{0,39}$'),
  alias_token bytea NOT NULL CHECK (octet_length(alias_token) = 32),
  token_key_version smallint NOT NULL CHECK (token_key_version > 0),
  participant_ref text NOT NULL CHECK (length(participant_ref) BETWEEN 1 AND 120),
  external_party_ref text CHECK (external_party_ref IS NULL OR length(external_party_ref) <= 200),
  projection_state public.alias_projection_state NOT NULL DEFAULT 'pending',
  source_system text NOT NULL CHECK (length(source_system) BETWEEN 1 AND 80),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 200),
  effective_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > effective_at),
  CHECK (projection_state <> 'active' OR (external_party_ref IS NOT NULL AND evidence_ref IS NOT NULL))
);
CREATE UNIQUE INDEX alias_associations_one_active_lookup_idx
  ON public.alias_associations(alias_type, alias_token) WHERE projection_state = 'active';
COMMENT ON COLUMN public.alias_associations.external_party_ref IS
  'Opaque partner-owned reference only; never store a raw party identifier, MSISDN, or phone number.';
CREATE INDEX alias_associations_phone_idx ON public.alias_associations(verified_phone_id, effective_at DESC);
ALTER TABLE public.alias_associations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.alias_associations FROM PUBLIC, anon, authenticated, service_role;
-- Alias search goes through a rate-limited PAL; no direct client lookup surface is granted.
GRANT SELECT, INSERT, UPDATE ON public.alias_associations TO service_role;

-- Opaque references only. Never store bank credentials, PAN, raw IBAN/account numbers, or access tokens here.
CREATE TABLE public.bank_links (
  bank_link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  partner_link_ref text NOT NULL CHECK (length(partner_link_ref) BETWEEN 1 AND 200),
  account_token_ref text CHECK (account_token_ref IS NULL OR length(account_token_ref) <= 200),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  link_state public.bank_link_state NOT NULL DEFAULT 'pending',
  consent_event_id uuid REFERENCES public.consent_events(consent_event_id) ON DELETE RESTRICT,
  ownership_evidence_ref text CHECK (ownership_evidence_ref IS NULL OR length(ownership_evidence_ref) <= 200),
  verified_at timestamptz,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (link_state <> 'active' OR (consent_event_id IS NOT NULL AND ownership_evidence_ref IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE OR REPLACE FUNCTION app_private.validate_bank_link_consent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private AS $$
DECLARE v_user uuid; v_action public.consent_action;
BEGIN
  IF NEW.link_state = 'active' THEN
    SELECT user_id, action INTO v_user, v_action FROM public.consent_events
      WHERE consent_event_id = NEW.consent_event_id;
    IF NOT FOUND OR v_user IS DISTINCT FROM NEW.user_id OR v_action <> 'granted'
       OR NEW.ownership_evidence_ref IS NULL OR NEW.verified_at IS NULL THEN
      RAISE EXCEPTION 'active bank link requires same-user granted consent and ownership evidence' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bank_links_consent_check BEFORE INSERT OR UPDATE OF link_state, user_id, consent_event_id,
  ownership_evidence_ref, verified_at ON public.bank_links
FOR EACH ROW EXECUTE FUNCTION app_private.validate_bank_link_consent();

COMMENT ON COLUMN public.bank_links.partner_link_ref IS
  'Opaque partner reference only; never a raw account number, IBAN, credential, or bearer token.';
COMMENT ON COLUMN public.bank_links.account_token_ref IS
  'Opaque reference into a partner-controlled token vault; no credential material.';
CREATE UNIQUE INDEX bank_links_partner_ref_idx ON public.bank_links(provider_key, partner_link_ref);
CREATE UNIQUE INDEX bank_links_one_active_default_per_currency_idx
  ON public.bank_links(user_id, currency) WHERE is_default AND link_state = 'active';
CREATE INDEX bank_links_user_state_idx ON public.bank_links(user_id, link_state);
CREATE TRIGGER bank_links_touch_updated_at BEFORE UPDATE ON public.bank_links
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
ALTER TABLE public.bank_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_links_read_own ON public.bank_links FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.bank_links FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (bank_link_id, user_id, provider_key, currency, link_state, is_default, verified_at, created_at)
  ON public.bank_links TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bank_links TO service_role;

COMMIT;
