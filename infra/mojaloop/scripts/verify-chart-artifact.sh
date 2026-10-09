#!/usr/bin/env bash
# Verify the official Mojaloop umbrella chart artifact for the disposable test Hub.
# Fails loudly and truthfully. NEVER run against a production or shared cluster.
# A successful run is evidence for release/chart-artifact.lock.yaml — nothing more.
set -euo pipefail

CHART_REPO_NAME="${CHART_REPO_NAME:-mojaloop}"
CHART_REPO_URL="${CHART_REPO_URL:-https://mojaloop.io/helm/repo/}"
CHART_NAME="${CHART_NAME:-mojaloop}"
CHART_VERSION="${CHART_VERSION:-17.2.0}"
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$BASE_DIR/.artifacts}"
VALUES_FILE="${VALUES_FILE:-$BASE_DIR/values/dev-reference.yaml}"

fail() { echo "ERROR: $*" >&2; exit 1; }

command -v helm >/dev/null 2>&1 || fail "Helm CLI is not installed in this environment.
Install Helm v3 to run chart verification. Do NOT claim any pull/render without a
successful run of this script."

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else fail "No checksum tool (sha256sum/shasum) available."; fi
}

mkdir -p "$ARTIFACTS_DIR"

echo "==> Adding/refreshing the official chart repository"
helm repo add "$CHART_REPO_NAME" "$CHART_REPO_URL"
helm repo update

echo "==> Inspecting chart metadata and default values"
helm show chart "$CHART_REPO_NAME/$CHART_NAME" --version "$CHART_VERSION" \
  | tee "$ARTIFACTS_DIR/chart-$CHART_VERSION-metadata.yaml"
helm show values "$CHART_REPO_NAME/$CHART_NAME" --version "$CHART_VERSION" \
  > "$ARTIFACTS_DIR/chart-$CHART_VERSION-default-values.yaml"
echo "    (diff values/dev-reference.yaml against the default values before rendering)"

echo "==> Pulling the exact package"
helm pull "$CHART_REPO_NAME/$CHART_NAME" --version "$CHART_VERSION" --destination "$ARTIFACTS_DIR"
TGZ="$ARTIFACTS_DIR/$CHART_NAME-$CHART_VERSION.tgz"
[ -f "$TGZ" ] || fail "Expected package $TGZ not found after pull."
SHA=$(checksum "$TGZ")
echo "==> Package SHA-256: $SHA"
echo "    Record this in release/chart-artifact.lock.yaml (package.sha256)."

echo "==> Linting with dev-reference values"
helm lint "$TGZ" --values "$VALUES_FILE"

echo "==> Rendering the local artifact (release name + chart are both required)"
RENDERED="$ARTIFACTS_DIR/rendered-demo.yaml"
helm template demo "$TGZ" --namespace demo --values "$VALUES_FILE" > "$RENDERED"
RSHA=$(checksum "$RENDERED")
echo "==> Rendered manifest SHA-256: $RSHA"

echo "==> Container image inventory (unique image references in the render)"
grep -E 'image:' "$RENDERED" | sed 's/^[[:space:]]*//' | sort -u \
  | tee "$ARTIFACTS_DIR/rendered-image-inventory.txt"

echo "==> Workload kind counts"
grep -E '^[[:space:]]*kind:' "$RENDERED" | sed 's/^[[:space:]]*kind:[[:space:]]*//' \
  | sort | uniq -c | sort -rn | tee "$ARTIFACTS_DIR/rendered-kind-counts.txt"

echo "==> Done. Copy checksums + inventory into release/chart-artifact.lock.yaml."
echo "    A successful render is NOT a compatibility certificate or deploy approval."
echo "    Keep the .tgz and rendered manifests OUT of git (.artifacts/ is ignored)."
