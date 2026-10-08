-- CI smoke assertions. Run AFTER ci/db/prepare.sql and all migrations, in order.
-- Any violation fails the psql run (use -v ON_ERROR_STOP=1). Disposable databases only.

-- 1) Expected tables exist after the full migration set.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles','verified_phones','alias_associations','bank_links',
    'payment_intents','payment_quotes','idempotency_records','payment_events',
    'journal_transactions','journal_entries','outbox_messages','inbox_events',
    'split_bills','split_shares'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'smoke: missing table public.%', t;
    END IF;
  END LOOP;
END
$$;

-- 2) Expected privileged functions exist with the reviewed signatures.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app_private.post_balanced_journal(text,text,text,text,bytea,jsonb)',
    'app_private.claim_outbox(text,integer,integer)',
    'app_private.finish_outbox(uuid,text,uuid,boolean,timestamptz,text)',
    'app_private.ingest_provider_event(text,text,bytea,smallint,uuid,uuid,text,jsonb)',
    'app_private.confirm_payment_intent(uuid,uuid,uuid,bytea,bytea,bytea,text,uuid)',
    'app_private.claim_split_share_invite(uuid,uuid,bytea)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'smoke: missing function %', f;
    END IF;
  END LOOP;
END
$$;

-- 3) Balanced journal: posting succeeds, replay with the same key returns the SAME journal.
DO $$
DECLARE v_id uuid; v_replay uuid; v_lines jsonb;
BEGIN
  v_lines := '[{"account_code":"PAYER_SIM_CLEARING","side":"debit","amount_minor":"1000"},{"account_code":"SIM_INTERNAL_CLEARING","side":"credit","amount_minor":"1000"}]'::jsonb;
  v_id := app_private.post_balanced_journal('XTS','ci-smoke','ci-ref-1','smoke',
    extensions.digest('ci-journal-key-1','sha256'), v_lines);
  IF v_id IS NULL THEN RAISE EXCEPTION 'smoke: journal posting returned no id'; END IF;
  v_replay := app_private.post_balanced_journal('XTS','ci-smoke','ci-ref-1','smoke',
    extensions.digest('ci-journal-key-1','sha256'), v_lines);
  IF v_replay IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'smoke: journal replay created a second journal';
  END IF;
END
$$;

-- 4) Unbalanced journal MUST be rejected.
DO $$
DECLARE v_conflict boolean := false;
BEGIN
  BEGIN
    PERFORM app_private.post_balanced_journal('XTS','ci-smoke','ci-ref-2','smoke',
      extensions.digest('ci-journal-key-2','sha256'),
      '[{"account_code":"A","side":"debit","amount_minor":"1000"},{"account_code":"B","side":"credit","amount_minor":"900"}]'::jsonb);
    v_conflict := true;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  IF v_conflict THEN RAISE EXCEPTION 'smoke: unbalanced journal was accepted'; END IF;
END
$$;

-- 5) Outbox: insert a durable command, claim it with a lease, wrong token is rejected,
--    correct token publishes it exactly once.
DO $$
DECLARE v_row record;
BEGIN
  INSERT INTO public.outbox_messages(aggregate_type, aggregate_id, command_type, schema_version,
      idempotency_key_sha256, payload_sha256, safe_payload)
    VALUES ('payment_intent', gen_random_uuid(), 'submit_payment', 1,
      extensions.digest('ci-outbox-key-1','sha256'),
      extensions.digest('ci-outbox-payload-1','sha256'),
      '{"ci":"outbox-smoke"}'::jsonb);
  SELECT * INTO v_row FROM app_private.claim_outbox('ci-worker', 5, 60);
  IF v_row.state <> 'leased' OR v_row.lease_owner <> 'ci-worker'
     OR v_row.attempts <> 1 OR v_row.lease_token IS NULL THEN
    RAISE EXCEPTION 'smoke: outbox claim did not lease the message';
  END IF;
  IF app_private.finish_outbox(v_row.outbox_message_id, 'ci-worker', gen_random_uuid(), true, NULL, NULL) THEN
    RAISE EXCEPTION 'smoke: outbox finish accepted a wrong lease token';
  END IF;
  IF NOT app_private.finish_outbox(v_row.outbox_message_id, 'ci-worker', v_row.lease_token, true, NULL, NULL) THEN
    RAISE EXCEPTION 'smoke: outbox finish with the correct token failed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.outbox_messages WHERE state <> 'published'
             AND idempotency_key_sha256 = extensions.digest('ci-outbox-key-1','sha256')) THEN
    RAISE EXCEPTION 'smoke: outbox message not published';
  END IF;
END
$$;

-- 6) Inbox dedupe: same (provider, event id) + same payload digest replays the same row;
--    a CHANGED payload under the same event id MUST be rejected.
DO $$
DECLARE v_a uuid; v_b uuid; v_conflict boolean := false;
BEGIN
  v_a := app_private.ingest_provider_event('sim-dfsp','ci-evt-1',
    extensions.digest('ci-inbox-payload-1','sha256'), 1, NULL, NULL, 'sim-hmac',
    '{"k":"v"}'::jsonb);
  v_b := app_private.ingest_provider_event('sim-dfsp','ci-evt-1',
    extensions.digest('ci-inbox-payload-1','sha256'), 1, NULL, NULL, 'sim-hmac',
    '{"k":"v"}'::jsonb);
  IF v_a IS NULL OR v_b IS DISTINCT FROM v_a THEN
    RAISE EXCEPTION 'smoke: duplicate inbox event created a second row';
  END IF;
  BEGIN
    PERFORM app_private.ingest_provider_event('sim-dfsp','ci-evt-1',
      extensions.digest('ci-inbox-payload-2','sha256'), 1, NULL, NULL, 'sim-hmac',
      '{"k":"v"}'::jsonb);
    v_conflict := true;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  IF v_conflict THEN RAISE EXCEPTION 'smoke: inbox accepted a changed payload under the same event id'; END IF;
END
$$;

-- Note: row-level ownership/authorization flows (payment intent -> quote -> confirm, invite claim)
-- need the identity fixtures from migration 0001 and are covered by the TICKET-004/006 test suites.
