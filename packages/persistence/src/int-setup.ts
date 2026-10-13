// Runs once before each integration test file (vitest setupFiles): truncate every app
// table so each *.int.test.ts starts from a clean disposable database. vitest.config.int.ts
// disables file parallelism, so this can never race another test file. auth.users is left
// alone because ids are deterministic and seeding is idempotent (ON CONFLICT DO NOTHING).
import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require a disposable Postgres database ' +
      'with ci/db/prepare.sql and all supabase/migrations applied (see README.md).',
  );
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query(`
    TRUNCATE TABLE
      public.alias_associations,
      public.bank_links,
      public.consent_events,
      public.idempotency_records,
      public.inbox_events,
      public.journal_entries,
      public.journal_transactions,
      public.outbox_messages,
      public.payment_events,
      public.payment_intents,
      public.payment_quotes,
      public.profiles,
      public.split_bills,
      public.split_shares,
      public.verified_phones
    RESTART IDENTITY CASCADE
  `);
} finally {
  await client.end();
}
