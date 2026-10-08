-- 202610060003_journal_outbox_inbox.sql
-- Product journal and delivery primitives. They are not the bank ledger or Mojaloop Central Ledger.
BEGIN;

CREATE TYPE public.journal_side AS ENUM ('debit', 'credit');
CREATE TYPE public.outbox_state AS ENUM ('pending', 'leased', 'published', 'dead_letter');
CREATE TYPE public.inbox_state AS ENUM ('received', 'processing', 'processed', 'quarantined');

CREATE TABLE public.journal_transactions (
  journal_transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_system text NOT NULL CHECK (length(source_system) BETWEEN 1 AND 80),
  external_reference text CHECK (external_reference IS NULL OR length(external_reference) <= 200),
  event_kind text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  idempotency_key_sha256 bytea NOT NULL CHECK (octet_length(idempotency_key_sha256) = 32),
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  UNIQUE (source_system, idempotency_key_sha256)
);
CREATE UNIQUE INDEX journal_transactions_external_ref_idx
  ON public.journal_transactions(source_system, external_reference) WHERE external_reference IS NOT NULL;

CREATE TABLE public.journal_entries (
  journal_entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_transaction_id uuid NOT NULL REFERENCES public.journal_transactions(journal_transaction_id) ON DELETE RESTRICT,
  account_code text NOT NULL CHECK (account_code ~ '^[A-Z0-9_.:-]{1,80}$'),
  side public.journal_side NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_transaction_idx ON public.journal_entries(journal_transaction_id);

CREATE OR REPLACE FUNCTION app_private.guard_journal_header()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'posted journal header is append-only' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.posted_at IS NOT NULL THEN
    RAISE EXCEPTION 'posted journal header is append-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_header_guard BEFORE UPDATE OR DELETE ON public.journal_transactions
FOR EACH ROW EXECUTE FUNCTION app_private.guard_journal_header();
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION app_private.reject_mutation();
ALTER TABLE public.journal_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.journal_transactions, public.journal_entries FROM PUBLIC, anon, authenticated, service_role;

-- A posting function is the only granted write path for the product journal. It validates
-- same-currency double entry and records the header, lines, and posted marker atomically.
CREATE OR REPLACE FUNCTION app_private.post_balanced_journal(
  p_currency text,
  p_source_system text,
  p_external_reference text,
  p_event_kind text,
  p_idempotency_key_sha256 bytea,
  p_lines jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $$
DECLARE
  v_journal_id uuid;
  v_existing_id uuid;
  v_existing_hash bytea;
  v_request_hash bytea;
  v_debits numeric;
  v_credits numeric;
  v_count integer;
BEGIN
  IF p_currency !~ '^[A-Z]{3}$' OR octet_length(p_idempotency_key_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid currency or idempotency digest' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 OR jsonb_array_length(p_lines) > 100 THEN
    RAISE EXCEPTION 'journal requires 2..100 lines' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) e
    WHERE jsonb_typeof(e) <> 'object'
       OR NOT (e ? 'account_code' AND e ? 'side' AND e ? 'amount_minor')
       OR e->>'account_code' !~ '^[A-Z0-9_.:-]{1,80}$'
       OR e->>'side' NOT IN ('debit', 'credit')
       OR COALESCE(e->>'amount_minor', '') !~ '^[1-9][0-9]*$'
  ) THEN
    RAISE EXCEPTION 'invalid journal line shape' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_lines) AS x(account_code text, side text, amount_minor numeric)
    WHERE amount_minor > 9223372036854775807::numeric
  ) THEN
    RAISE EXCEPTION 'journal line amount exceeds bigint range' USING ERRCODE = '22003';
  END IF;
  SELECT count(*),
         COALESCE(sum(amount_minor) FILTER (WHERE side = 'debit'), 0),
         COALESCE(sum(amount_minor) FILTER (WHERE side = 'credit'), 0)
    INTO v_count, v_debits, v_credits
    FROM jsonb_to_recordset(p_lines) AS x(account_code text, side text, amount_minor numeric);
  IF v_count < 2 OR v_debits <= 0 OR v_debits <> v_credits THEN
    RAISE EXCEPTION 'journal is not balanced' USING ERRCODE = '23514';
  END IF;
  v_request_hash := extensions.digest(convert_to(p_currency || '|' || p_source_system || '|' ||
    COALESCE(p_external_reference, '') || '|' || p_event_kind || '|' || p_lines::text, 'UTF8'), 'sha256');

  INSERT INTO public.journal_transactions(currency, source_system, external_reference, event_kind,
      idempotency_key_sha256, request_sha256)
    VALUES (p_currency::char(3), p_source_system, p_external_reference, p_event_kind,
      p_idempotency_key_sha256, v_request_hash)
    ON CONFLICT (source_system, idempotency_key_sha256) DO NOTHING
    RETURNING journal_transaction_id INTO v_journal_id;
  IF v_journal_id IS NULL THEN
    SELECT journal_transaction_id, request_sha256 INTO v_existing_id, v_existing_hash
      FROM public.journal_transactions
      WHERE source_system = p_source_system AND idempotency_key_sha256 = p_idempotency_key_sha256
      FOR UPDATE;
    IF v_existing_hash <> v_request_hash THEN
      RAISE EXCEPTION 'idempotency key reused with different journal request' USING ERRCODE = '22023';
    END IF;
    RETURN v_existing_id;
  END IF;

  INSERT INTO public.journal_entries(journal_transaction_id, account_code, side, amount_minor, currency)
    SELECT v_journal_id, x.account_code, x.side::public.journal_side, x.amount_minor::bigint, p_currency::char(3)
    FROM jsonb_to_recordset(p_lines) AS x(account_code text, side text, amount_minor numeric);
  UPDATE public.journal_transactions SET posted_at = clock_timestamp()
    WHERE journal_transaction_id = v_journal_id;
  RETURN v_journal_id;
END;
$$;
REVOKE ALL ON FUNCTION app_private.post_balanced_journal(text, text, text, text, bytea, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.post_balanced_journal(text, text, text, text, bytea, jsonb) TO service_role;

CREATE TABLE public.outbox_messages (
  outbox_message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  aggregate_id uuid NOT NULL,
  command_type text NOT NULL CHECK (command_type ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  schema_version smallint NOT NULL CHECK (schema_version > 0),
  idempotency_key_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(idempotency_key_sha256) = 32),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  safe_payload jsonb NOT NULL CHECK (jsonb_typeof(safe_payload) = 'object'),
  state public.outbox_state NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) <= 120),
  lease_token uuid,
  lease_until timestamptz,
  published_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (state <> 'published' OR published_at IS NOT NULL)
);
CREATE INDEX outbox_claim_idx ON public.outbox_messages(state, available_at, created_at);
ALTER TABLE public.outbox_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbox_messages FROM PUBLIC, anon, authenticated, service_role;
-- Insert is reserved for trusted transactional command code; workers claim/finish through functions.
GRANT SELECT, INSERT ON public.outbox_messages TO service_role;

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
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
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

CREATE OR REPLACE FUNCTION app_private.finish_outbox(
  p_message_id uuid, p_worker text, p_lease_token uuid, p_published boolean, p_retry_at timestamptz, p_error_code text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE v_updated integer;
BEGIN
  UPDATE public.outbox_messages
     SET state = CASE WHEN p_published THEN 'published'::public.outbox_state
                      WHEN p_retry_at IS NOT NULL THEN 'pending'::public.outbox_state
                      ELSE 'dead_letter'::public.outbox_state END,
         published_at = CASE WHEN p_published THEN clock_timestamp() ELSE NULL END,
         available_at = COALESCE(p_retry_at, available_at),
         lease_owner = NULL, lease_token = NULL, lease_until = NULL,
         last_error_code = CASE WHEN p_published THEN NULL ELSE left(COALESCE(p_error_code, 'unspecified'), 100) END
   WHERE outbox_message_id = p_message_id AND state = 'leased' AND lease_owner = p_worker AND lease_token = p_lease_token;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;
REVOKE ALL ON FUNCTION app_private.finish_outbox(uuid, text, uuid, boolean, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.finish_outbox(uuid, text, uuid, boolean, timestamptz, text) TO service_role;

CREATE TABLE public.inbox_events (
  inbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  schema_version smallint NOT NULL CHECK (schema_version > 0),
  payment_intent_id uuid REFERENCES public.payment_intents(payment_intent_id) ON DELETE RESTRICT,
  correlation_id uuid,
  authenticated_principal text NOT NULL CHECK (length(authenticated_principal) BETWEEN 1 AND 160),
  signature_verified boolean NOT NULL DEFAULT true CHECK (signature_verified),
  normalized_payload jsonb NOT NULL CHECK (jsonb_typeof(normalized_payload) = 'object'),
  state public.inbox_state NOT NULL DEFAULT 'received',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider_key, provider_event_id),
  CHECK ((state = 'processed') = (processed_at IS NOT NULL))
);
CREATE INDEX inbox_pending_idx ON public.inbox_events(state, received_at);
ALTER TABLE public.inbox_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_events FROM PUBLIC, anon, authenticated, service_role;
-- Trusted worker only: the raw body is not stored; normalized minimal payload is access-restricted.
GRANT SELECT, UPDATE ON public.inbox_events TO service_role;

-- Call only after transport/business authentication and schema validation succeed. The function
-- stores normalized minimal data plus a payload hash, not raw signed bodies or secrets.
CREATE OR REPLACE FUNCTION app_private.ingest_provider_event(
  p_provider_key text, p_provider_event_id text, p_payload_sha256 bytea, p_schema_version smallint,
  p_payment_intent_id uuid, p_correlation_id uuid, p_authenticated_principal text, p_normalized_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE v_id uuid; v_existing_hash bytea;
BEGIN
  IF octet_length(p_payload_sha256) <> 32 OR jsonb_typeof(p_normalized_payload) <> 'object'
     OR p_provider_key IS NULL OR p_provider_event_id IS NULL OR p_authenticated_principal IS NULL THEN
    RAISE EXCEPTION 'invalid authenticated provider event envelope' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.inbox_events(provider_key, provider_event_id, payload_sha256, schema_version,
      payment_intent_id, correlation_id, authenticated_principal, normalized_payload)
    VALUES (p_provider_key, p_provider_event_id, p_payload_sha256, p_schema_version,
      p_payment_intent_id, p_correlation_id, p_authenticated_principal, p_normalized_payload)
    ON CONFLICT (provider_key, provider_event_id) DO NOTHING
    RETURNING inbox_event_id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT inbox_event_id, payload_sha256 INTO v_id, v_existing_hash
    FROM public.inbox_events WHERE provider_key = p_provider_key AND provider_event_id = p_provider_event_id;
  IF v_existing_hash <> p_payload_sha256 THEN
    RAISE EXCEPTION 'provider event id reused with different payload hash' USING ERRCODE = '22023';
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app_private.ingest_provider_event(text, text, bytea, smallint, uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.ingest_provider_event(text, text, bytea, smallint, uuid, uuid, text, jsonb) TO service_role;

-- Quote-bound confirmation: idempotency row, authorized projection, append-only event and outbox
-- command are committed together. The PAL must authenticate the user and verify step-up before calling.
CREATE OR REPLACE FUNCTION app_private.confirm_payment_intent(
  p_actor_user_id uuid,
  p_payment_intent_id uuid,
  p_quote_id uuid,
  p_quote_binding_hash bytea,
  p_request_sha256 bytea,
  p_idempotency_key_sha256 bytea,
  p_authorization_evidence_ref text,
  p_correlation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $$
DECLARE
  v_payment public.payment_intents%ROWTYPE;
  v_quote public.payment_quotes%ROWTYPE;
  v_idem public.idempotency_records%ROWTYPE;
  v_inserted uuid;
  v_event_hash bytea;
BEGIN
  IF octet_length(p_quote_binding_hash) <> 32 OR octet_length(p_request_sha256) <> 32
     OR octet_length(p_idempotency_key_sha256) <> 32 OR p_authorization_evidence_ref IS NULL
     OR length(p_authorization_evidence_ref) > 200 THEN
    RAISE EXCEPTION 'invalid confirmation envelope' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.idempotency_records(actor_user_id, operation, key_sha256, request_sha256, resource_id, record_state)
    VALUES (p_actor_user_id, 'confirm-payment', p_idempotency_key_sha256, p_request_sha256,
      p_payment_intent_id, 'reserved')
    ON CONFLICT (actor_user_id, operation, key_sha256) DO NOTHING
    RETURNING idempotency_record_id INTO v_inserted;
  IF v_inserted IS NULL THEN
    SELECT * INTO v_idem FROM public.idempotency_records
     WHERE actor_user_id = p_actor_user_id AND operation = 'confirm-payment'
       AND key_sha256 = p_idempotency_key_sha256 FOR UPDATE;
    IF v_idem.request_sha256 <> p_request_sha256 THEN
      RAISE EXCEPTION 'idempotency key reused with different request' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('payment_intent_id', v_idem.resource_id,
      'state', v_idem.record_state, 'replayed', true);
  END IF;

  SELECT * INTO v_payment FROM public.payment_intents
    WHERE payment_intent_id = p_payment_intent_id FOR UPDATE;
  IF NOT FOUND OR v_payment.user_id <> p_actor_user_id THEN
    RAISE EXCEPTION 'payment intent not found for actor' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_quote FROM public.payment_quotes
    WHERE quote_id = p_quote_id AND payment_intent_id = p_payment_intent_id;
  IF NOT FOUND OR v_quote.expires_at <= clock_timestamp()
     OR v_quote.binding_hash <> p_quote_binding_hash
     OR v_quote.currency <> v_payment.currency
     OR v_quote.requested_amount_minor <> v_payment.requested_amount_minor THEN
    RAISE EXCEPTION 'quote missing, expired, or not bound to intent' USING ERRCODE = '22023';
  END IF;
  IF v_payment.payment_state <> 'quoted' OR v_payment.current_quote_id IS DISTINCT FROM p_quote_id THEN
    RAISE EXCEPTION 'payment is not confirmable in current state' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.bank_links b WHERE b.bank_link_id = v_payment.source_bank_link_id
      AND b.user_id = p_actor_user_id AND b.link_state = 'active' AND b.currency = v_payment.currency)
     OR NOT EXISTS (SELECT 1 FROM public.alias_associations a
       LEFT JOIN public.verified_phones ph ON ph.verified_phone_id = a.verified_phone_id
       WHERE a.alias_association_id = v_payment.recipient_alias_id AND a.projection_state = 'active'
         AND a.effective_at <= clock_timestamp() AND (a.expires_at IS NULL OR a.expires_at > clock_timestamp())
         AND (ph.verification_state IS NULL OR ph.verification_state = 'verified')) THEN
    RAISE EXCEPTION 'source link or recipient alias is no longer eligible' USING ERRCODE = '55000';
  END IF;

  UPDATE public.payment_intents SET
    payment_state = 'user_authorized', current_quote_id = p_quote_id,
    quoted_fee_minor = v_quote.quoted_fee_minor, payer_debit_minor = v_quote.payer_debit_minor,
    recipient_amount_minor = v_quote.recipient_amount_minor,
    authorized_at = clock_timestamp(), authorization_evidence_ref = p_authorization_evidence_ref,
    request_fingerprint = p_request_sha256
    WHERE payment_intent_id = p_payment_intent_id;
  v_event_hash := extensions.digest(convert_to('UserAuthorized|' || encode(p_request_sha256, 'hex'), 'UTF8'), 'sha256');
  INSERT INTO public.payment_events(payment_intent_id, event_type, schema_version, source_system,
      correlation_id, previous_payment_state, next_payment_state, payload_sha256, privacy_class, safe_metadata)
    VALUES (p_payment_intent_id, 'UserAuthorized', 1, 'pal', p_correlation_id,
      v_payment.payment_state, 'user_authorized', v_event_hash, 'sensitive_reference',
      jsonb_build_object('quote_id', p_quote_id, 'quote_binding_sha256', encode(p_quote_binding_hash, 'hex')));
  INSERT INTO public.outbox_messages(aggregate_type, aggregate_id, command_type, schema_version,
      idempotency_key_sha256, payload_sha256, safe_payload)
    VALUES ('payment_intent', p_payment_intent_id, 'submit_payment', 1,
      p_idempotency_key_sha256,
      extensions.digest(convert_to(p_payment_intent_id::text || '|' || p_quote_id::text || '|' || encode(p_quote_binding_hash, 'hex'), 'UTF8'), 'sha256'),
      jsonb_build_object('payment_intent_id', p_payment_intent_id,
        'quote_id', p_quote_id, 'correlation_id', p_correlation_id,
        'quote_binding_sha256', encode(p_quote_binding_hash, 'hex')));
  UPDATE public.idempotency_records SET record_state = 'accepted', updated_at = clock_timestamp()
    WHERE idempotency_record_id = v_inserted;
  RETURN jsonb_build_object('payment_intent_id', p_payment_intent_id,
    'state', 'user_authorized', 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION app_private.confirm_payment_intent(uuid, uuid, uuid, bytea, bytea, bytea, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.confirm_payment_intent(uuid, uuid, uuid, bytea, bytea, bytea, text, uuid) TO service_role;

COMMIT;
