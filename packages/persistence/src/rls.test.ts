// TICKET-004 acceptance: RLS and grant paths. anon is denied everywhere, authenticated
// sees only its own rows through the JWT claim and is denied ungranted columns, and
// service_role server-side reads work. Each probe uses a dedicated, disposable
// connection so the impersonated role never leaks back into the pool.

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sha256Hex } from '@eeeasy-pay/pal';
import { createPersistenceSql, type Sql } from './client.ts';
import {
  createHarness,
  databaseUrl,
  expectPgError,
  seedIdentity,
  seedQuotedIntent,
  testUuid,
  truncateAll,
  type Harness,
  type Seed,
  type SeedUser,
} from './test-support.ts';

describe.skipIf(!databaseUrl)('RLS and grant probes', () => {
  const h: Harness = createHarness(databaseUrl);
  let seed: Seed;
  let splitBillId: string;

  beforeEach(async () => {
    await truncateAll(h);
    seed = await seedIdentity(h);
    const [alice, bob] = seed.users;
    if (!alice || !bob) {
      throw new Error('seed identity failed');
    }
    await seedQuotedIntent(h, alice);
    await seedQuotedIntent(h, bob);
    splitBillId = testUuid();
    await h.splits.createBill({
      splitBillId,
      ownerId: alice.userId,
      title: 'rls probe bill',
      currency: 'XTS',
      totalMinor: 2000n,
      shares: [
        {
          amountMinor: 1000n,
          inviteTokenDigest: sha256Hex('invite:rls-a'),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        {
          amountMinor: 1000n,
          inviteTokenDigest: sha256Hex('invite:rls-b'),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });
  });

  afterAll(async () => {
    await h.sql.end({ timeout: 5 });
  });

  function alice(): SeedUser {
    const user = seed.users[0];
    if (!user) {
      throw new Error('seed identity failed');
    }
    return user;
  }

  function carol(): SeedUser {
    const user = seed.users[2];
    if (!user) {
      throw new Error('seed identity failed');
    }
    return user;
  }

  /**
   * Opens a fresh single-connection pool, demotes it to the requested role, sets the
   * JWT claim like the CI auth.uid() fixture does, runs the probe, then destroys the
   * connection. The superuser pool is never touched by the impersonated role.
   */
  async function asRole<T>(
    role: 'anon' | 'authenticated' | 'service_role',
    claimSub: string | null,
    probe: (reserved: Awaited<ReturnType<Sql['reserve']>>) => Promise<T>,
  ): Promise<T> {
    const sql = createPersistenceSql(databaseUrl);
    let reserved: Awaited<ReturnType<Sql['reserve']>> | undefined;
    try {
      reserved = await sql.reserve();
      await reserved`SELECT set_config('request.jwt.claim.sub', ${claimSub ?? ''}, false)`;
      await reserved`SELECT set_config('role', ${role}, false)`;
      return await probe(reserved);
    } finally {
      // The reserved connection must go back to its (single-connection) pool
      // before end(), otherwise end() waits on it until the test times out.
      if (reserved) {
        reserved.release();
      }
      await sql.end({ timeout: 5 });
    }
  }

  it('denies anon on payment intents and on app_private functions', async () => {
    await asRole('anon', null, async (reserved) => {
      await expectPgError(
        () => reserved`SELECT payment_intent_id FROM public.payment_intents`,
        '42501',
      );
      await expectPgError(() => reserved`SELECT app_private.claim_outbox('probe', 1, 5)`, '42501');
    });
  });

  it('shows an authenticated user only their own rows', async () => {
    await asRole('authenticated', alice().userId, async (reserved) => {
      const rows = await reserved<
        { n: number }[]
      >`SELECT count(payment_intent_id)::int AS n FROM public.payment_intents`;
      expect(rows[0]?.n).toBe(1);
      const quotes = await reserved<
        { n: number }[]
      >`SELECT count(quote_id)::int AS n FROM public.payment_quotes`;
      expect(quotes[0]?.n).toBe(1);
      const events = await reserved<
        { n: number }[]
      >`SELECT count(payment_event_id)::int AS n FROM public.payment_events`;
      expect(events[0]?.n).toBe(2);
    });
    // Without a JWT claim the same role sees nothing.
    await asRole('authenticated', null, async (reserved) => {
      const rows = await reserved<
        { n: number }[]
      >`SELECT count(payment_intent_id)::int AS n FROM public.payment_intents`;
      expect(rows[0]?.n).toBe(0);
    });
  });

  it('denies authenticated reads of ungranted columns', async () => {
    await asRole('authenticated', alice().userId, async (reserved) => {
      await expectPgError(
        () => reserved`SELECT request_fingerprint FROM public.payment_intents`,
        '42501',
      );
      await expectPgError(() => reserved`SELECT phone_token FROM public.verified_phones`, '42501');
    });
  });

  it('enforces split membership predicates for authenticated users', async () => {
    await asRole('authenticated', alice().userId, async (reserved) => {
      const own = await reserved<{ ok: boolean }[]>`
        SELECT app_private.can_read_split_bill(${splitBillId}::uuid) AS ok`;
      expect(own[0]?.ok).toBe(true);
      const bills = await reserved<
        { n: number }[]
      >`SELECT count(split_bill_id)::int AS n FROM public.split_bills`;
      expect(bills[0]?.n).toBe(1);
    });
    await asRole('authenticated', carol().userId, async (reserved) => {
      const foreign = await reserved<{ ok: boolean }[]>`
        SELECT app_private.can_read_split_bill(${splitBillId}::uuid) AS ok`;
      expect(foreign[0]?.ok).toBe(false);
      const bills = await reserved<
        { n: number }[]
      >`SELECT count(split_bill_id)::int AS n FROM public.split_bills`;
      expect(bills[0]?.n).toBe(0);
    });
  });

  it('lets the server-side service_role read product rows and claim the outbox', async () => {
    await asRole('service_role', null, async (reserved) => {
      const rows = await reserved<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM public.payment_intents`;
      expect(rows[0]?.n).toBe(2);
      const idem = await reserved<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.idempotency_records`;
      expect(idem[0]?.n).toBe(0);
      const claimed = await reserved<{ outbox_message_id: string }[]>`
        SELECT app_private.claim_outbox('service-probe', 5, 60)`;
      expect(claimed).toHaveLength(0);
    });
  });
});

