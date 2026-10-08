-- 202610060004_split_bills.sql
-- Coordination-only split domain: every share is a separate payment authorization and transfer.
BEGIN;

CREATE TYPE public.split_bill_state AS ENUM ('draft', 'open', 'closed', 'cancelled');
CREATE TYPE public.split_share_state AS ENUM ('unpaid', 'payment_pending', 'paid', 'failed', 'expired', 'cancelled', 'needs_review');
CREATE TYPE public.payment_origin AS ENUM ('direct_p2p', 'split_share');

CREATE TABLE public.split_bills (
  split_bill_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor > 0),
  split_state public.split_bill_state NOT NULL DEFAULT 'draft',
  rounding_policy text NOT NULL DEFAULT 'explicit_minor_units' CHECK (rounding_policy IN ('explicit_minor_units', 'remainder_to_first_share')),
  closes_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at IS NULL OR closes_at > created_at)
);
CREATE INDEX split_bills_owner_time_idx ON public.split_bills(owner_user_id, created_at DESC);
CREATE TRIGGER split_bills_touch_updated_at BEFORE UPDATE ON public.split_bills
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

CREATE TABLE public.split_shares (
  split_share_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  split_bill_id uuid NOT NULL REFERENCES public.split_bills(split_bill_id) ON DELETE RESTRICT,
  participant_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  invite_token_sha256 bytea CHECK (invite_token_sha256 IS NULL OR octet_length(invite_token_sha256) = 32),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  share_state public.split_share_state NOT NULL DEFAULT 'unpaid',
  latest_payment_intent_id uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (participant_user_id IS NOT NULL OR invite_token_sha256 IS NOT NULL),
  UNIQUE (split_share_id, split_bill_id)
);
CREATE UNIQUE INDEX split_shares_invite_hash_idx ON public.split_shares(invite_token_sha256)
  WHERE invite_token_sha256 IS NOT NULL;
CREATE INDEX split_shares_bill_state_idx ON public.split_shares(split_bill_id, share_state);
CREATE INDEX split_shares_user_idx ON public.split_shares(participant_user_id, created_at DESC)
  WHERE participant_user_id IS NOT NULL;
CREATE TRIGGER split_shares_touch_updated_at BEFORE UPDATE ON public.split_shares
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

ALTER TABLE public.payment_intents
  ADD COLUMN payment_origin public.payment_origin NOT NULL DEFAULT 'direct_p2p',
  ADD COLUMN split_share_id uuid REFERENCES public.split_shares(split_share_id) ON DELETE RESTRICT,
  ADD CONSTRAINT payment_intents_origin_share_check CHECK (
    (payment_origin = 'direct_p2p' AND split_share_id IS NULL) OR
    (payment_origin = 'split_share' AND split_share_id IS NOT NULL)
  );
CREATE INDEX payment_intents_split_share_idx ON public.payment_intents(split_share_id)
  WHERE split_share_id IS NOT NULL;
ALTER TABLE public.split_shares ADD CONSTRAINT split_shares_latest_payment_fk
  FOREIGN KEY (latest_payment_intent_id) REFERENCES public.payment_intents(payment_intent_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION app_private.assert_split_bill_balanced()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE v_bill_id uuid; v_state public.split_bill_state; v_total bigint; v_sum numeric; v_count bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_bill_id := OLD.split_bill_id;
  ELSE
    v_bill_id := NEW.split_bill_id;
  END IF;
  SELECT split_state, total_minor INTO v_state, v_total
    FROM public.split_bills WHERE split_bill_id = v_bill_id;
  IF NOT FOUND OR v_state <> 'open' THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(amount_minor::numeric), 0), count(*) INTO v_sum, v_count
    FROM public.split_shares WHERE split_bill_id = v_bill_id;
  IF v_count < 2 OR v_sum <> v_total THEN
    RAISE EXCEPTION 'open split bill must have at least two shares summing exactly to total_minor'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER split_shares_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON public.split_shares
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app_private.assert_split_bill_balanced();
CREATE CONSTRAINT TRIGGER split_bills_balance_check
  AFTER INSERT OR UPDATE ON public.split_bills
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app_private.assert_split_bill_balanced();

CREATE OR REPLACE FUNCTION app_private.assert_split_payment_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE v_participant uuid; v_state public.split_bill_state; v_share_state public.split_share_state;
        v_currency char(3); v_amount bigint;
BEGIN
  IF NEW.split_share_id IS NULL THEN RETURN NEW; END IF;
  SELECT s.participant_user_id, b.split_state, s.share_state, b.currency, s.amount_minor
    INTO v_participant, v_state, v_share_state, v_currency, v_amount
    FROM public.split_shares s JOIN public.split_bills b ON b.split_bill_id = s.split_bill_id
    WHERE s.split_share_id = NEW.split_share_id;
  IF NOT FOUND OR v_state <> 'open' OR v_share_state IN ('paid', 'cancelled', 'expired')
     OR (v_participant IS NOT NULL AND v_participant <> NEW.user_id)
     OR NEW.currency <> v_currency OR NEW.requested_amount_minor <> v_amount THEN
    RAISE EXCEPTION 'payment intent does not match an eligible split share' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_intents_split_owner_check BEFORE INSERT OR UPDATE OF split_share_id, user_id, payment_origin
  ON public.payment_intents FOR EACH ROW EXECUTE FUNCTION app_private.assert_split_payment_owner();

-- SECURITY DEFINER membership predicates avoid recursive RLS policies between bills and shares.
-- Each function derives the caller from auth.uid(); clients cannot probe membership for another user.
CREATE OR REPLACE FUNCTION app_private.can_read_split_bill(p_split_bill_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
  SELECT EXISTS (SELECT 1 FROM public.split_bills b WHERE b.split_bill_id = p_split_bill_id AND b.owner_user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.split_shares s WHERE s.split_bill_id = p_split_bill_id AND s.participant_user_id = auth.uid())
$$;
CREATE OR REPLACE FUNCTION app_private.can_read_split_share(p_split_share_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
  SELECT EXISTS (SELECT 1 FROM public.split_shares s WHERE s.split_share_id = p_split_share_id AND s.participant_user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.split_shares s JOIN public.split_bills b ON b.split_bill_id = s.split_bill_id
                 WHERE s.split_share_id = p_split_share_id AND b.owner_user_id = auth.uid())
$$;
GRANT USAGE ON SCHEMA app_private TO authenticated;
REVOKE ALL ON FUNCTION app_private.can_read_split_bill(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_private.can_read_split_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.can_read_split_bill(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.can_read_split_share(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.guard_split_bill_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, app_private AS $$
BEGIN
  IF OLD.split_state IN ('closed', 'cancelled') AND NEW.split_state <> OLD.split_state THEN
    RAISE EXCEPTION 'closed/cancelled split is terminal' USING ERRCODE = '55000';
  END IF;
  IF OLD.split_state = 'draft' AND NEW.split_state NOT IN ('draft', 'open', 'cancelled') THEN
    RAISE EXCEPTION 'invalid split bill transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.split_state = 'open' AND NEW.split_state NOT IN ('open', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'invalid split bill transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.split_state <> 'draft' AND
     (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.rounding_policy IS DISTINCT FROM OLD.rounding_policy) THEN
    RAISE EXCEPTION 'split owner, currency, total and allocation policy are immutable after opening' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER split_bills_guard_update BEFORE UPDATE ON public.split_bills
FOR EACH ROW EXECUTE FUNCTION app_private.guard_split_bill_update();

CREATE OR REPLACE FUNCTION app_private.guard_open_split_share()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private AS $$
DECLARE v_state public.split_bill_state; v_bill_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_bill_id := OLD.split_bill_id;
  ELSE
    v_bill_id := NEW.split_bill_id;
  END IF;
  SELECT split_state INTO v_state FROM public.split_bills WHERE split_bill_id = v_bill_id;
  IF v_state = 'open' THEN
    IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'share membership and amount cannot change after bill opens' USING ERRCODE = '55000';
    ELSIF NEW.split_bill_id IS DISTINCT FROM OLD.split_bill_id
       OR NEW.participant_user_id IS DISTINCT FROM OLD.participant_user_id
       OR NEW.invite_token_sha256 IS DISTINCT FROM OLD.invite_token_sha256
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'share membership and amount cannot change after bill opens' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER split_shares_guard_open BEFORE INSERT OR UPDATE OR DELETE ON public.split_shares
FOR EACH ROW EXECUTE FUNCTION app_private.guard_open_split_share();

CREATE OR REPLACE FUNCTION app_private.assert_split_latest_payment_matches()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private AS $$
DECLARE v_share_id uuid;
BEGIN
  IF NEW.latest_payment_intent_id IS NULL THEN RETURN NEW; END IF;
  SELECT split_share_id INTO v_share_id FROM public.payment_intents
    WHERE payment_intent_id = NEW.latest_payment_intent_id;
  IF NOT FOUND OR v_share_id IS DISTINCT FROM NEW.split_share_id THEN
    RAISE EXCEPTION 'latest payment intent must belong to this split share' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER split_shares_latest_payment_check BEFORE INSERT OR UPDATE OF latest_payment_intent_id
  ON public.split_shares FOR EACH ROW EXECUTE FUNCTION app_private.assert_split_latest_payment_matches();

ALTER TABLE public.split_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.split_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY split_bills_read_owner_or_member ON public.split_bills FOR SELECT TO authenticated
  USING (app_private.can_read_split_bill(split_bill_id));
CREATE POLICY split_shares_read_owner_or_member ON public.split_shares FOR SELECT TO authenticated
  USING (app_private.can_read_split_share(split_share_id));
REVOKE ALL ON public.split_bills, public.split_shares FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (split_bill_id, owner_user_id, title, currency, total_minor, split_state, rounding_policy, closes_at, created_at)
  ON public.split_bills TO authenticated;
GRANT SELECT (split_share_id, split_bill_id, participant_user_id, amount_minor, share_state, expires_at, created_at)
  ON public.split_shares TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.split_bills, public.split_shares TO service_role;

COMMIT;
