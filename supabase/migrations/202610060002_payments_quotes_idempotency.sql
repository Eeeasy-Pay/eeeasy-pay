-- 202610060002_payments_quotes_idempotency.sql
-- Product-side intent and evidence projections only; no bank, DFSP or Mojaloop authority.
BEGIN;

CREATE TYPE public.payment_state AS ENUM (
  'created', 'lookup_pending', 'quoting', 'quoted', 'user_authorized',
  'transfer_submitted', 'transfer_processing', 'transfer_prepared', 'transfer_committed',
  'recipient_credit_pending', 'completed', 'rejected', 'expired',
  'unknown_reconciliation', 'compensation_pending', 'manual_resolution'
);
CREATE TYPE public.source_account_state AS ENUM (
  'not_started', 'pending', 'reserved', 'debited', 'rejected', 'unknown', 'released', 'returned'
);
CREATE TYPE public.scheme_transfer_state AS ENUM (
  'not_started', 'pending', 'prepared', 'committed', 'rejected', 'expired', 'unknown'
);
CREATE TYPE public.recipient_credit_state AS ENUM (
  'not_started', 'pending', 'credited', 'rejected', 'unknown', 'returned'
);
CREATE TYPE public.settlement_state AS ENUM ('not_applicable', 'pending', 'settled', 'exception', 'unknown');
CREATE TYPE public.reconciliation_state AS ENUM ('not_required', 'open', 'matched', 'mismatch', 'resolved');
CREATE TYPE public.idempotency_state AS ENUM ('reserved', 'accepted', 'completed', 'unknown', 'failed');

CREATE TABLE public.payment_intents (
  payment_intent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  source_bank_link_id uuid NOT NULL REFERENCES public.bank_links(bank_link_id) ON DELETE RESTRICT,
  recipient_alias_id uuid NOT NULL REFERENCES public.alias_associations(alias_association_id) ON DELETE RESTRICT,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  requested_amount_minor bigint NOT NULL CHECK (requested_amount_minor > 0),
  quoted_fee_minor bigint NOT NULL DEFAULT 0 CHECK (quoted_fee_minor >= 0),
  payer_debit_minor bigint CHECK (payer_debit_minor IS NULL OR payer_debit_minor > 0),
  recipient_amount_minor bigint CHECK (recipient_amount_minor IS NULL OR recipient_amount_minor > 0),
  payment_state public.payment_state NOT NULL DEFAULT 'created',
  source_account_state public.source_account_state NOT NULL DEFAULT 'not_started',
  scheme_transfer_state public.scheme_transfer_state NOT NULL DEFAULT 'not_started',
  recipient_credit_state public.recipient_credit_state NOT NULL DEFAULT 'not_started',
  settlement_state public.settlement_state NOT NULL DEFAULT 'not_applicable',
  reconciliation_state public.reconciliation_state NOT NULL DEFAULT 'not_required',
  current_quote_id uuid,
  authorized_at timestamptz,
  authorization_evidence_ref text CHECK (authorization_evidence_ref IS NULL OR length(authorization_evidence_ref) <= 200),
  request_fingerprint bytea CHECK (request_fingerprint IS NULL OR octet_length(request_fingerprint) = 32),
  connector_key text CHECK (connector_key IS NULL OR length(connector_key) <= 80),
  external_transfer_id text CHECK (external_transfer_id IS NULL OR length(external_transfer_id) <= 200),
  source_instruction_ref text CHECK (source_instruction_ref IS NULL OR length(source_instruction_ref) <= 200),
  recipient_credit_ref text CHECK (recipient_credit_ref IS NULL OR length(recipient_credit_ref) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payer_debit_minor IS NULL OR (payer_debit_minor >= quoted_fee_minor AND
         payer_debit_minor = requested_amount_minor + quoted_fee_minor)),
  CHECK (payment_state <> 'completed' OR recipient_credit_state = 'credited'),
  CHECK ((authorized_at IS NULL AND authorization_evidence_ref IS NULL) OR
         (authorized_at IS NOT NULL AND authorization_evidence_ref IS NOT NULL AND current_quote_id IS NOT NULL))
);
CREATE OR REPLACE FUNCTION app_private.validate_payment_route()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private AS $$
DECLARE v_link_user uuid; v_link_currency char(3); v_link_state public.bank_link_state;
        v_alias_state public.alias_projection_state; v_alias_effective timestamptz; v_alias_expires timestamptz;
        v_phone_state public.phone_verification_state; v_check_route boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_check_route := true;
  ELSE
    IF OLD.current_quote_id IS NOT NULL AND
       (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.source_bank_link_id IS DISTINCT FROM OLD.source_bank_link_id
        OR NEW.recipient_alias_id IS DISTINCT FROM OLD.recipient_alias_id OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.requested_amount_minor IS DISTINCT FROM OLD.requested_amount_minor) THEN
      RAISE EXCEPTION 'payment route and amount are immutable after a quote is attached' USING ERRCODE = '55000';
    END IF;
    v_check_route := NEW.current_quote_id IS DISTINCT FROM OLD.current_quote_id
      OR NEW.source_bank_link_id IS DISTINCT FROM OLD.source_bank_link_id
      OR NEW.recipient_alias_id IS DISTINCT FROM OLD.recipient_alias_id;
  END IF;
  IF v_check_route THEN
    SELECT user_id, currency, link_state INTO v_link_user, v_link_currency, v_link_state
      FROM public.bank_links WHERE bank_link_id = NEW.source_bank_link_id;
    IF NOT FOUND OR v_link_user IS DISTINCT FROM NEW.user_id OR v_link_currency <> NEW.currency OR v_link_state <> 'active' THEN
      RAISE EXCEPTION 'source bank link is not active for this actor and currency' USING ERRCODE = '23514';
    END IF;
    SELECT a.projection_state, a.effective_at, a.expires_at, ph.verification_state
      INTO v_alias_state, v_alias_effective, v_alias_expires, v_phone_state
      FROM public.alias_associations a LEFT JOIN public.verified_phones ph ON ph.verified_phone_id = a.verified_phone_id
      WHERE a.alias_association_id = NEW.recipient_alias_id;
    IF NOT FOUND OR v_alias_state <> 'active' OR v_alias_effective > now()
       OR (v_alias_expires IS NOT NULL AND v_alias_expires <= now())
       OR (v_phone_state IS NOT NULL AND v_phone_state <> 'verified') THEN
      RAISE EXCEPTION 'recipient alias projection is not active and current' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_intents_route_check BEFORE INSERT OR UPDATE OF user_id, source_bank_link_id,
  recipient_alias_id, currency, requested_amount_minor, current_quote_id ON public.payment_intents
FOR EACH ROW EXECUTE FUNCTION app_private.validate_payment_route();

CREATE UNIQUE INDEX payment_intents_external_transfer_idx ON public.payment_intents(connector_key, external_transfer_id)
  WHERE connector_key IS NOT NULL AND external_transfer_id IS NOT NULL;
CREATE INDEX payment_intents_user_time_idx ON public.payment_intents(user_id, created_at DESC);
CREATE INDEX payment_intents_state_age_idx ON public.payment_intents(payment_state, updated_at);
CREATE TRIGGER payment_intents_touch_updated_at BEFORE UPDATE ON public.payment_intents
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_intents_read_own ON public.payment_intents FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.payment_intents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (payment_intent_id, user_id, currency, requested_amount_minor, quoted_fee_minor, payer_debit_minor,
  recipient_amount_minor, payment_state, source_account_state, scheme_transfer_state, recipient_credit_state,
  settlement_state, reconciliation_state, current_quote_id, authorized_at, created_at, updated_at)
  ON public.payment_intents TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.payment_intents TO service_role;

CREATE TABLE public.payment_quotes (
  quote_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES public.payment_intents(payment_intent_id) ON DELETE RESTRICT,
  provider_key text NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 80),
  partner_quote_ref text NOT NULL CHECK (length(partner_quote_ref) BETWEEN 1 AND 200),
  api_profile text NOT NULL CHECK (length(api_profile) BETWEEN 1 AND 80),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  requested_amount_minor bigint NOT NULL CHECK (requested_amount_minor > 0),
  quoted_fee_minor bigint NOT NULL CHECK (quoted_fee_minor >= 0),
  payer_debit_minor bigint NOT NULL CHECK (payer_debit_minor > 0),
  recipient_amount_minor bigint NOT NULL CHECK (recipient_amount_minor > 0),
  fee_rule_version text NOT NULL CHECK (length(fee_rule_version) BETWEEN 1 AND 80),
  quote_terms jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quote_terms) = 'object'),
  request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
  binding_hash bytea NOT NULL CHECK (octet_length(binding_hash) = 32),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > issued_at),
  CHECK (payer_debit_minor = requested_amount_minor + quoted_fee_minor),
  UNIQUE (provider_key, partner_quote_ref),
  UNIQUE (quote_id, payment_intent_id)
);
CREATE INDEX payment_quotes_intent_expiry_idx ON public.payment_quotes(payment_intent_id, expires_at DESC);
ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_quote_same_intent_fk
  FOREIGN KEY (current_quote_id, payment_intent_id)
  REFERENCES public.payment_quotes(quote_id, payment_intent_id) ON DELETE RESTRICT;
ALTER TABLE public.payment_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_quotes_read_own ON public.payment_quotes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.payment_intents p
                 WHERE p.payment_intent_id = payment_quotes.payment_intent_id
                   AND p.user_id = (SELECT auth.uid())));
REVOKE ALL ON public.payment_quotes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (quote_id, payment_intent_id, api_profile, currency, requested_amount_minor, quoted_fee_minor,
  payer_debit_minor, recipient_amount_minor, fee_rule_version, issued_at, expires_at)
  ON public.payment_quotes TO authenticated;
GRANT SELECT, INSERT ON public.payment_quotes TO service_role;

CREATE TABLE public.idempotency_records (
  idempotency_record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  key_sha256 bytea NOT NULL CHECK (octet_length(key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  resource_id uuid,
  record_state public.idempotency_state NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (actor_user_id, operation, key_sha256)
);
CREATE INDEX idempotency_resource_idx ON public.idempotency_records(resource_id) WHERE resource_id IS NOT NULL;
CREATE TRIGGER idempotency_records_touch_updated_at BEFORE UPDATE ON public.idempotency_records
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.idempotency_records FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.idempotency_records TO service_role;

CREATE TABLE public.payment_events (
  payment_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id uuid NOT NULL REFERENCES public.payment_intents(payment_intent_id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[A-Za-z][A-Za-z0-9_.-]{0,99}$'),
  schema_version smallint NOT NULL CHECK (schema_version > 0),
  source_system text NOT NULL CHECK (length(source_system) BETWEEN 1 AND 80),
  external_event_id text CHECK (external_event_id IS NULL OR length(external_event_id) <= 200),
  correlation_id uuid NOT NULL,
  causation_id uuid,
  occurred_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  previous_payment_state public.payment_state,
  next_payment_state public.payment_state,
  source_account_state public.source_account_state,
  scheme_transfer_state public.scheme_transfer_state,
  recipient_credit_state public.recipient_credit_state,
  settlement_state public.settlement_state,
  reconciliation_state public.reconciliation_state,
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  privacy_class text NOT NULL CHECK (privacy_class IN ('operational_minimal', 'sensitive_reference')),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_metadata) = 'object')
);
CREATE UNIQUE INDEX payment_events_external_dedupe_idx ON public.payment_events(source_system, external_event_id)
  WHERE external_event_id IS NOT NULL;
CREATE INDEX payment_events_payment_time_idx ON public.payment_events(payment_intent_id, recorded_at);
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON public.payment_events
FOR EACH ROW EXECUTE FUNCTION app_private.reject_mutation();
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_events_read_own ON public.payment_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.payment_intents p
                 WHERE p.payment_intent_id = payment_events.payment_intent_id
                   AND p.user_id = (SELECT auth.uid())));
REVOKE ALL ON public.payment_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (payment_event_id, payment_intent_id, event_type, schema_version, source_system, correlation_id,
  occurred_at, recorded_at, previous_payment_state, next_payment_state, source_account_state,
  scheme_transfer_state, recipient_credit_state, settlement_state, reconciliation_state)
  ON public.payment_events TO authenticated;
GRANT SELECT, INSERT ON public.payment_events TO service_role;

COMMIT;
