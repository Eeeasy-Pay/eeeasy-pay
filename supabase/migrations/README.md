# Migration set rules

- Directory `supabase/migrations` is the single source of truth. No embedded or consolidated
  SQL copy is maintained; if one is ever introduced, every change must update it together with
  this README, the manifest, and the tests.
- Migrations are **forward-only**. Never edit or reorder `202610060001` through
  `202610060005` as a shortcut; any migration already applied outside local development is
  immutable. Schema changes require a new forward-only migration.
- Apply in filename order:

  1. `202610060001_foundation_identity_consent_links.sql` - profiles, verified phones, alias
     projections, bank links, consent events (product identity data only).
  2. `202610060002_payments_quotes_idempotency.sql` - payment intents with separated evidence
     dimensions, immutable quotes with binding hash, server-scoped idempotency, append-only events.
  3. `202610060003_journal_outbox_inbox.sql` - balanced product journal (posting function is the
     only write path), outbox with lease-based claiming, authenticated inbox with dedupe,
     transactional quote-bound confirmation.
  4. `202610060004_split_bills.sql` - coordination-only split bills and shares; every share is a
     separate payment authorization. Balanced-open invariant, membership guards, RLS.
  5. `202610060005_split_share_invite_redemption.sql` - one-time, authenticated invite claim
     function, command-time expiry checks. **Reviewed draft**: its contents were verified against
     the reviewed design source, but its grants, tests, and ordering must be independently
     reviewed before being treated as applied anywhere beyond a disposable local database.

  6. `202610060006_fix_claim_outbox_lock_clause_order.sql` - forward-only defect fix: the
     reviewed `claim_outbox` body placed `FOR UPDATE SKIP LOCKED` before `LIMIT` in its
     picking CTE, which PostgreSQL rejects when the function is first executed (plpgsql
     bodies parse lazily, so migration 0003 still applied). Signature, lease contract,
     validation, and grants are unchanged. See ADR-009 / D-07.

- These migrations create **product-side data only**. They are never a bank ledger, DFSP
  customer-account record, Mojaloop participant transfer record, or settlement evidence.
- `ci/db/prepare.sql` synthesizes the `auth` schema/roles that Supabase normally provides.
  It is for disposable CI/local databases only and must never run against a real environment.
- Quote expiry is enforced at command time (see `confirm_payment_intent` in 0003 and the
  command-time checks in 0005). There is deliberately **no** time-based database trigger,
  duplicate expiry column, enum, or timer worker. `GET /status` projections may report an
  elapsed quote as expired and non-confirmable without mutating any row.
