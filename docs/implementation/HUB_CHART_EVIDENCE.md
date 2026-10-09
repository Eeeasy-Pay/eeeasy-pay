# Hub chart verification evidence — mojaloop/mojaloop v17.2.0

**Date:** 2026-10-08 · **Workstream:** operator (TICKETS 009/010, D-09/ADR-011)
**Environment:** repository tooling only — no Helm, kubectl, or Kubernetes cluster
available (B-10). No pull, lint, render, or install was executed.

## What was actually verified (read from official sources)

| Source | What was checked | Result |
|---|---|---|
| `mojaloop/Chart.yaml` at tag [v17.2.0](https://github.com/mojaloop/helm/blob/v17.2.0/mojaloop/Chart.yaml) | Chart identity and dependency set | OK — complete dependency list recorded in `infra/mojaloop/release/chart-artifact.lock.yaml`. Chart version 17.2.0; appVersion is a descriptive service-version list (ml-api-adapter v16.9.2, central-ledger v19.12.7, account-lookup-service v17.15.2, quoting-service v17.14.3, central-settlement v17.3.3, bulk-api-adapter v17.2.5, …), confirming chart, subchart, and image versions are separately versioned. |
| `mojaloop/values.yaml` at the same tag | Values structure | OK — CONFIG anchors with MySQL backends for ALS/MSISDN oracle/central-ledger, Kafka for messaging, etc. Structure inspected only; no values copied into this repository. |
| GitHub release [v17.2.0](https://github.com/mojaloop/helm/releases/tag/v17.2.0) | Official release record | OK — tag v17.2.0, release commit `aaee1fb`, published 2026-05-04, commit signed with GitHub-verified signature (GPG key `B5690EEEBB952194`). Release notes describe enhancements and breaking changes over v17.1.0 (notification mechanism, inter-scheme discovery, FX error handling, TTK fixes). |

## What was NOT verified (do not claim)

- No `helm pull`: the package SHA-256 is **not** recorded yet (PENDING in the manifest).
- No `helm lint`, no `helm template` render, no install, no `helm test`: no rendered
  workload/image inventory exists yet.
- No `.prov`/provenance verification (only meaningful if officially published with a
  trusted key).
- No compatibility claim of any kind: v17.2.0 remains a test/reproducibility reference
  only (B-02, ADR-011).

Note: the chart repository index (`https://mojaloop.io/helm/repo/index.yaml`) could not
be fetched through this environment's web proxy (access denied at the origin), so the
package digest must come from an actual `helm pull` — never from a hand-copied value.

## How to complete verification (blocked on B-10)

On a disposable dev/test environment with Helm v3 installed, run:

```bash
infra/mojaloop/scripts/verify-chart-artifact.sh
```

Then record the outputs (package SHA-256, rendered-manifest checksum, image inventory,
kind counts, Helm/Kubernetes versions) in `infra/mojaloop/release/chart-artifact.lock.yaml`
and append a dated section to this file. Keep the `.tgz` and rendered manifests out of
git. The full procedure (including optional disposable install/teardown) is in
`infra/mojaloop/README.md`.
