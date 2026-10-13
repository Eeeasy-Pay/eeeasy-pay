import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { Db } from './db.ts';
import {
  CURRENCY,
  deterministicId,
  seedActiveAlias,
  seedActiveBankLink,
  seedQuotedIntent,
  seedUser,
} from './int-helpers.ts';
import { createPersistenceStores } from './stores.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require a disposable Postgres database ' +
      'with ci/db/prepare.sql and all supabase/migrations applied (see README.md).',
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const stores = createPersistenceStores(pool);
const db: Db = stores.db;

const RLS_A = deterministicId('user', 'rls-a');
const RLS_B = deterministicId('user', 'rls-b');
const RLS_SVC = deterministicId('user', 'rls-svc');

type TestRole = 'anon' | 'authenticated' | 'service_role';

/** Impersonates a Supabase role on a dedicated client, mirroring the CI grant probes. */
async function withRole<T>(
  role: TestRole,
  sub: string | null,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET ROLE ${role}`);
    if (sub !== null) {
      await client.query('SELECT set_config($1, $2, false)', ['request.jwt.claim.sub', sub]);
    }
    return await run(client);
  } finally {
    try {
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  }
}

afterAll(async () => {
  await pool.end();
});

describe('RLS and grant paths (anon / authenticated / service_role)', () => {
  it('seeds per-actor intents for the role probes', async () => {
    await seedUser(db, RLS_A);
    await seedUser(db, RLS_B);
    await seedUser(db, RLS_SVC);
    await seedQuotedIntent(db, stores, { userId: RLS_A, ref: 'rls-a' });
    await seedQuotedIntent(db, stores, { userId: RLS_B, ref: 'rls-b' });
  });

  it('denies anon on product tables and on app_private functions', async () => {
    await expect(
      withRole('anon', null, (client) =>
        client.query('SELECT count(*) FROM public.payment_intents'),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withRole('anon', null, (client) =>
        client.query("SELECT app_private.claim_outbox('probe', 1, 5)"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('lets authenticated read only its own rows through RLS, and only granted columns', async () => {
    // No jwt claim: zero rows visible, but the query itself is granted.
    await expect(
      withRole('authenticated', null, (client) =>
        client.query<{ n: string }>('SELECT count(*)::text AS n FROM public.payment_intents'),
      ),
    ).resolves.toMatchObject({ rows: [{ n: '0' }] });

    // With a claim: exactly the actor's own rows.
    const own = await withRole('authenticated', RLS_A, (client) =>
      client.query<{ n: string }>('SELECT count(*)::text AS n FROM public.payment_intents'),
    );
    expect(own.rows[0]?.n).toBe('1');

    // Ungranted columns stay unreadable even for the owning actor.
    await expect(
      withRole('authenticated', RLS_A, (client) =>
        client.query('SELECT request_fingerprint FROM public.payment_intents'),
      ),
    ).rejects.toThrow(/permission denied/);

    // The granted membership predicate is callable and returns false without membership.
    await expect(
      withRole('authenticated', RLS_A, (client) =>
        client.query<{ ok: boolean }>('SELECT app_private.can_read_split_bill(NULL::uuid) AS ok'),
      ),
    ).resolves.toMatchObject({ rows: [{ ok: false }] });
  });

  it('lets service_role read everything and write through its direct grants', async () => {
    // The CI fixture grants service_role BYPASSRLS like managed Supabase (ADR-016).
    const visible = await withRole('service_role', null, (client) =>
      client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM public.payment_intents WHERE user_id IN ($1, $2)',
        [RLS_A, RLS_B],
      ),
    );
    expect(visible.rows[0]?.n).toBe('2');

    // A direct INSERT (granted to service_role only) still passes the route trigger.
    const bankLinkId = await seedActiveBankLink(db, RLS_SVC, 'rls-svc');
    const aliasId = await seedActiveAlias(db, 'rls-svc');
    const intentId = deterministicId('intent', 'rls-svc');
    await expect(
      withRole('service_role', null, (client) =>
        client.query(
          `INSERT INTO public.payment_intents
             (payment_intent_id, user_id, source_bank_link_id, recipient_alias_id,
              currency, requested_amount_minor)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [intentId, RLS_SVC, bankLinkId, aliasId, CURRENCY, 700],
        ),
      ),
    ).resolves.toBeDefined();
    const record = await stores.intents.findOwnedById(intentId, RLS_SVC);
    expect(record?.state).toBe('created');
    expect(record?.requestedAmountMinor).toBe(700n);
  });
});
