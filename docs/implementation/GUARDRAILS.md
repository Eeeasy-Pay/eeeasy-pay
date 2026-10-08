# Engineering guardrails

These rules are binding for every contributor, including AI coding agents. They encode the
reviewed product/architecture decisions. When in doubt, stop and record the question in
`OPEN_DECISIONS.md` instead of guessing.

## 1. Orchestration-only

eeeasy-pay is a consumer experience and orchestration layer integrated through a sponsoring
DFSP. It is NOT a DFSP, wallet, custodian, deposit-taker, settlement bank, or owner/controller
of customer funds. The draft pooled-master-account/pass-through model is NOT implemented and
must not be reintroduced without a new reviewed decision.

## 2. Simulator-only

- No moving real funds, calling production banks or Mojaloop, requesting or adding live
  credentials, creating production accounts, or representing this prototype as certified or
  launch-ready.
- All partner-dependent behavior lives behind typed ports (`packages/ports`) with a
  deterministic fake/simulator (`packages/sponsor-dfsp-connector`).
- Never invent a partner API, adapter URL, signature/JWS or mTLS profile, callback schema,
  exact FSPIOP version, fee, currency, account-link flow, alias policy, refund rule, latency
  commitment, or release compatibility. The FSPIOP v1.1 spec is not a universal deployment
  pin; exact resource versions and behavior come from the signed scheme/partner profile.
- The product's `SponsorDfspPort` is an internal product interface. It is NOT a claim about
  the SDK Scheme Adapter's universal API. Do not implement FSPIOP signing or fabricate
  JWS/mTLS headers without the selected deployment profile.

## 3. Evidence dimensions stay separate

Product payment state, source-account posting, scheme transfer state, recipient credit,
participant settlement, and reconciliation are separate evidence dimensions. A quote, HTTP
response, local row, callback receipt, push notification, or product journal entry alone
NEVER implies bank credit or settlement. All external evidence in this repository is marked
`SIMULATOR` and must be displayed as simulated.

## 4. Money and state correctness

- Exact integer minor units (bigint), never binary floating point. Currency is a placeholder
  until a partner profile fixes the currency set.
- Payment completion requires the configured recipient-credit evidence gate; in simulator
  mode the evidence source is explicitly `SIMULATOR` and never displayed as real settlement.
- Client idempotency keys are untrusted correlation inputs. Server-scoped idempotency must
  include actor, operation, and canonical request fingerprint. Same key + same request
  returns the prior result; same key + different request returns a conflict.
- After an ambiguous timeout, NEVER retry with a new external ID; query/reconcile the
  original operation.
- Quote expiry is enforced at command time. A GET/status response may project an elapsed
  quote as expired and non-confirmable without mutating state. Do not add time-based
  database triggers, duplicate expiry columns, enums, or timer workers.
- Split allocation is deterministic and exact; an open split bill must have at least two
  shares summing exactly to its total. Claiming an invite is NOT a payment authorization.

## 5. Data and security

- Never store raw phone numbers, bank account credentials, contact lists, OTPs, or secrets
  in logs, fixtures, or test data. Do not store raw signed callback bodies.
- Never expose `service_role` or connector credentials to the mobile app. Privileged
  functions keep fixed `search_path`, least-privilege execute grants, and no
  public/authenticated execution unless explicitly designed.
- Test actor ownership, cross-user isolation, query enumeration resistance, callback
  authentication at the simulator boundary, input validation, and redaction.
- Contact discovery/address-book upload is OFF. No HMAC, OPRF/PSI, retention, or contact
  migration selection. Refunds are deferred until the partner flow and decision D-12 define
  authority, evidence, accounting, timing, and errors.

## 6. Migrations are forward-only

Never edit applied migrations. New schema change = new forward-only migration, updated
together with README, tests, and manifest. Migration 0005 is a reviewed draft: validate its
grants, tests, and ordering before treating it as applied anywhere beyond a disposable local
database. See `supabase/migrations/README.md`.

## 7. Product surface

- Product-side routes only: `POST /v1/payment-intents`, `GET /v1/payment-intents/{id}`,
  `POST /v1/payment-intents/{id}/confirm`, status, and split routes. Return `202 Accepted`
  for durable asynchronous work. Use the closed problem-code set and correlation IDs.
- Never expose a Mojaloop endpoint directly to the mobile client.
- The API must distinguish `submitted`, `processing`, `unknown/needs reconciliation`,
  `recipient credited (simulated)`, and settlement state, and never label simulated evidence
  as a real transfer.

## 8. Claims discipline

Report only what was actually run and verified. Do not say "production-ready" when only local
checks ran. Do not claim the Mojaloop Helm chart v17.2.0 (test/reproducibility reference only)
was rendered unless it actually was, with the chart artifact and exact evidence recorded.
Toolchain pins are CI-proposed until the first green CI run. Never claim unverified
compatibility.
