# Central Hub release inputs (infra/mojaloop/)

Owned by the organization as intended technical Scheme/Hub Operator (D-08, ADR-010).
The deployable central Hub unit is the official `mojaloop/mojaloop` umbrella Helm chart
(D-09, ADR-011). Rules that always apply here:

- NEVER clone or vendor Mojaloop source service repositories into this monorepo.
- NEVER deploy the DFSP SDK Scheme Adapter / core connector here; it stays in the DFSP
  trust zone. The central `ml-api-adapter` is a different, Hub-side component.
- v17.2.0 is a test/reproducibility reference ONLY — not a compatibility certificate.
- Every Helm command must name a chart (and a release where the command requires one).
- If Helm or a cluster is unavailable, say so; never claim a pull/render/install that
  did not run (blocker B-10).

## Current status (honest)

- Chart v17.2.0 metadata was inspected from the official tagged sources; findings are
  recorded in `release/chart-artifact.lock.yaml` and `docs/implementation/HUB_CHART_EVIDENCE.md`.
- NO pull, lint, render, or install has been performed in this repository yet
  (no Helm/Kubernetes available in the current tooling — B-10).

## Layout

- `release/chart-artifact.lock.yaml` — project-owned release manifest (NOT Helm's Chart.lock).
- `values/dev-reference.yaml` — non-secret baseline for disposable test renders.
- `values/overlays/thirdparty-pisp-dev.yaml` — CONDITIONAL: isolated synthetic PISP trial only.
- `scripts/verify-chart-artifact.sh` — pull / checksum / lint / render / inventory; fails
  loudly when Helm is missing.
- `.artifacts/` — local working area, git-ignored. Never commit the `.tgz`, rendered
  manifests, or credentials.

## Safe disposable dev/test procedure

Run all of this ONLY against a disposable, isolated dev/test cluster with synthetic data.
Never point it at a production or shared cluster. Keep secrets in the approved secret
manager, never in Git or rendered logs.

1. Add the official chart repository and inspect:
   `helm repo add mojaloop https://mojaloop.io/helm/repo/ && helm repo update`
   `helm search repo mojaloop/mojaloop --versions`
   `helm show chart mojaloop/mojaloop --version 17.2.0`
   `helm show values mojaloop/mojaloop --version 17.2.0`  (diff against
   `values/dev-reference.yaml` before rendering)
2. Pull the exact package and record its SHA-256 (see the script; the script does this).
3. Lint and render the LOCAL artifact with reviewed values:
   `helm lint infra/mojaloop/.artifacts/mojaloop-17.2.0.tgz --values infra/mojaloop/values/dev-reference.yaml`
   `helm template demo infra/mojaloop/.artifacts/mojaloop-17.2.0.tgz --namespace demo --values infra/mojaloop/values/dev-reference.yaml`
4. Record chart/subchart/image versions, checksums, and the rendered workload inventory
   in `release/chart-artifact.lock.yaml`. Chart number, subchart version, appVersion and
   image tags are SEPARATE fields — never collapse them.
5. (Optional, disposable cluster only) install into an isolated `demo` namespace, run
   `helm status` / `helm test`, then FULLY tear down (`helm uninstall`, delete the namespace
   only after confirming it contains nothing wanted).
6. A successful render or test install is NOT production approval. Production promotion
   remains gated (see OPEN_DECISIONS B-02/B-10 and the PRD launch gates).

The Third Party (PISP) overlay stays OFF for the sponsor-channel baseline; enable it only
for the isolated synthetic PISP-path trial via `values/overlays/thirdparty-pisp-dev.yaml`,
and provision its external MySQL/Redis dependencies separately (the chart's example
backend/manifests are PoC/dev/test only).
