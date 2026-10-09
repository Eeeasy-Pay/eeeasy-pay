import { describe, expect, it } from 'vitest';
import { SimulatorSponsorDfspConnector, StaticClock } from './simulator.ts';

const clock = (iso: string): StaticClock => new StaticClock(new Date(iso));

describe('SimulatorSponsorDfspConnector.quote', () => {
  it('produces deterministic quote terms with an explicit simulator fee', async () => {
    const sim = new SimulatorSponsorDfspConnector(clock('2026-10-08T00:00:00.000Z'));
    const q = await sim.quote({
      paymentIntentId: 'pi-1',
      correlationId: 'c-1',
      currency: 'XTS',
      requestedAmountMinor: 1000n,
    });
    expect(q.providerKey).toBe('sim-dfsp');
    expect(q.apiProfile).toBe('SIMULATOR');
    expect(q.quotedFeeMinor).toBe(1n);
    expect(q.payerDebitMinor).toBe(1001n);
    expect(q.recipientAmountMinor).toBe(1000n);
    expect(q.partnerQuoteRef).toBe('SQ-000001');
    expect(q.issuedAt).toBe('2026-10-08T00:00:00.000Z');
    expect(q.expiresAt).toBe('2026-10-08T00:01:00.000Z');
  });
  it('rejects non-positive amounts', async () => {
    const sim = new SimulatorSponsorDfspConnector(clock('2026-10-08T00:00:00.000Z'));
    await expect(
      sim.quote({ paymentIntentId: 'pi', correlationId: 'c', currency: 'XTS', requestedAmountMinor: 0n }),
    ).rejects.toThrow();
  });
});

describe('scripted submission scenarios', () => {
  const sim = new SimulatorSponsorDfspConnector(clock('2026-10-08T00:00:00.000Z'), {
    script: ['success', 'reject', 'timeout_unknown'],
  });
  const cmd = { paymentIntentId: 'pi-1', quoteId: 'q-1', quoteBindingDigest: 'ab'.repeat(32), correlationId: 'c-1' };

  it('cycles success -> reject -> timeout_unknown with sequential ids', async () => {
    const first = await sim.submitTransfer(cmd);
    expect(first.kind).toBe('committed');
    expect((first as { externalTransferId: string }).externalTransferId).toBe('STX-000001');

    const second = await sim.submitTransfer(cmd);
    expect(second.kind).toBe('rejected');
    expect((second as { reasonCode: string }).reasonCode).toBe('simulator_rejected');

    const third = await sim.submitTransfer(cmd);
    expect(third.kind).toBe('timeout_unknown');
    expect((third as { externalTransferId: string }).externalTransferId).toBe('STX-000003');
  });
  it('marks committed results as SIMULATOR evidence only', async () => {
    const outcome = await sim.submitTransfer(cmd);
    expect(outcome.kind).toBe('committed');
    expect((outcome as { evidenceSource: string }).evidenceSource).toBe('SIMULATOR');
  });
});

describe('reconciliation of ambiguous outcomes', () => {
  it('resolves timeout_unknown by querying the ORIGINAL external id, never resubmitting', async () => {
    const sim = new SimulatorSponsorDfspConnector(clock('2026-10-08T00:00:00.000Z'), {
      script: ['timeout_unknown'],
    });
    const cmd = { paymentIntentId: 'pi-1', quoteId: 'q-1', quoteBindingDigest: 'ab'.repeat(32), correlationId: 'c-1' };
    const outcome = await sim.submitTransfer(cmd);
    if (outcome.kind !== 'timeout_unknown') {
      throw new Error('expected timeout_unknown');
    }
    const query = await sim.queryTransfer(outcome.externalTransferId);
    expect(query.externalTransferId).toBe(outcome.externalTransferId);
    expect(query.status).toBe('committed');
    expect(query.evidenceSource).toBe('SIMULATOR');
  });
  it('reports unknown for ids it never received', async () => {
    const sim = new SimulatorSponsorDfspConnector(clock('2026-10-08T00:00:00.000Z'));
    expect((await sim.queryTransfer('STX-999999')).status).toBe('unknown');
  });
});
