# CLI setup order

Use [staged preparation](spec-preparation.md) as the complete workflow for a new
DogeOS deployment. Run commands with the current built/installed CLI and matching
release inputs, from the private operator directory. Preparation does not create
an EKS cluster or install Helm releases; runtime acceptance follows deployment.

```bash
scrollsdk setup plan --spec deployment-spec.yaml --output deployment
scrollsdk setup genesis --dir deployment
scrollsdk setup aws --dir deployment
```

Follow the next stage reported by each command. The plan selects the required
steps; a stage checks prerequisites and does not execute another stage for you.
See the [command reference](spec-preparation.md#commands) for Bridge funding,
protocol context, proof materials, signer kit publication and other handoffs.

`setup aws` can be repeated. It rechecks resources, reuses saved keys and
credentials, and converges the selected workload roles before binding their ARNs.
A failed repeat blocks dependent stages until AWS preparation succeeds. It does
not replay genesis or funding. Preserve the deployment directory and its private
records so an interrupted attempt can resume with the same identities.

Only current v3 plans are supported. Old plans and incompatible workflow layouts
are rejected without migration. Preserve old directories and their original CLI
for recovery. `setup apply` is retired. `gen-keystore`, `eth-da-submitter`,
`proof-aws-init` and the legacy signer commands are internal resource steps, not
an independent deployment workflow.

Final configuration and secret preparation use the saved plan:

```bash
scrollsdk setup render --dir deployment
# When selected by the plan:
scrollsdk setup signer-session --dir deployment
scrollsdk setup upload-secrets --dir deployment
```

The signer session is an explicit stage, separate from rendering. Preparation
preserves operator values and the Makefile. Follow the
[runtime and activation checks](deployment-preflight.md#6-opt-into-cluster-rpc-and-reth-startup-checks)
before installation and [contract verification](deployment-preflight.md#8-check-final-contract-verification)
after source submission. The focused operational utilities below are available
for their stated tasks; they do not replace the staged workflow.

## Command visibility

`setup --help` lists deployment stages and independently useful operator tools.
The lower-level commands below are hidden from the command list because their
normal deployment use is covered by the saved plan. They remain callable by the
stage runner and by name for the focused maintenance procedures documented here;
`setup <command> --help` still explains their flags. Hiding a command does not
change its execution or bypass its existing safeguards.

| Public workflow | Hidden lower-level commands |
| --- | --- |
| Spec and plan initialization | `generate-from-spec`, `doge-config`, `attestation-signer`, `domains`, `tls` |
| `genesis` | `gen-l2-artifacts` |
| `aws` | `db-init`, `dstack-config` |
| `bridge-funding` | `bridge-init` |
| Proof material preparation and compilation | `proof-image-tools`, `proof-release-prepare`, `proof-topology-compile`, `proof-worker-image-check` |
| `proof-publish` | `proof-bundle-publish` |
| `signer-kit`, `signer-kit-publish` | `export-deployment-kit`, `publish-deployment-kit` |
| `render` and earlier chart reconciliation | `prep-charts`, `gen-secrets` |
| `upload-secrets` | `push-secrets`, `monitoring-secrets` |

Validation, network inspection, worker lifecycle, session recovery and governance
handoff commands remain visible because preparation stages do not replace those
operator tasks. The already internal-only signer/resource commands and retired
`apply` retain their existing execution restrictions.

## Publish proof programs to an existing AWS S3 store

After importing the real preparation receipt and compiling the active/real
topology, the complete 11-file bundle can be published without creating EKS
workload roles. Use the canonical `proofArtifacts.s3` bucket, prefix,
region and regional AWS endpoint already present in `doge-config`:

```bash
scrollsdk setup proof-bundle-publish --artifact-source doge-config \
  --release dogeos-proof-release-v1.json --release-sha256 "$RELEASE_SHA256" --json
scrollsdk setup proof-bundle-publish --artifact-source doge-config \
  --release dogeos-proof-release-v1.json --release-sha256 "$RELEASE_SHA256" \
  --aws-profile "$PUBLICATION_PROFILE" --apply --json
```

The publication profile must return unexpired temporary credentials. The CLI
uses the immutable publisher image, preserves bucket policy, and writes a receipt
only after authenticated and anonymous reads match all 11 source files. This
explicit mode supports direct regional AWS S3; a non-AWS endpoint is rejected.
The default `--artifact-source proof-aws` continues to use `.data/proof-aws.json`
and its configured public transport. Neither publishing mode proves that the
runtime workloads have IAM permissions; provision and validate those separately
before rollout. The saved `proof-materials`/`proof-publish` stages still
requires the provisioned resource facts.

The standalone publisher does not modify the deployment contract. Bind its
receipt explicitly when regenerating values, then regenerate secrets:

```bash
scrollsdk setup prep-charts \
  --proof-materials-receipt .data/proof-materials-v1.json \
  --proof-publication-receipt .data/proof-program-publication-v1.json
scrollsdk setup gen-secrets
scrollsdk setup deployment-preflight --json
```

For active/real deployments the final check also requires the artifact-store
resource receipt. Successful standalone publication does not satisfy that
separate requirement or any production signer evidence requirement.

## CubeSigner Wasm preparation and attachment

When the correctness signer uses the hosted verifier policy, export its Wasm
from the core release's policy compiler image. `export-deployment-kit` generates
the signer deployment kit; it does not produce this CubeSigner Wasm.

The policy's release values (artifact origin and base path, program commitment,
aggregation VK, namespace) are constants committed in the core release, so the
compiler image takes no inputs. It runs without network, writes
`cubesigner_verifier_policy.wasm` and `cubesigner_verifier_policy.wasm.sha256`,
and is reproducible: the same image always yields the same Wasm.

The image is published only to the private GitHub package
`ghcr.io/dogeos69/cubesigner-policy-compiler` (tagged with the core release tag),
because the Wasm is compiled against the private Cubist policy SDK. Pulling it
requires a GitHub token with the `read:packages` scope from an account with
access to the package. Log in once on the operator host, reading the token from
an environment variable or secret store rather than the command line:

```bash
printf '%s' "$GHCR_READ_PACKAGES_TOKEN" | docker login ghcr.io -u "$GITHUB_USER" --password-stdin
```

Clusters never run this image (the Wasm is uploaded to CubeSigner), so they need
no pull secret for it. If another host must pull it, give it the same kind of
token as a registry credential (for Kubernetes, an `imagePullSecrets` entry of
type `kubernetes.io/dockerconfigjson` for `ghcr.io`).

```bash
scrollsdk setup cubesigner-policy build \
  --compiler-image "ghcr.io/dogeos69/cubesigner-policy-compiler@sha256:$POLICY_COMPILER_DIGEST" \
  --expected-core-revision "$CORE_REVISION" \
  --output .data/cubesigner-policy-build --json
```

The compiler image must be pinned by digest, and its
`org.opencontainers.image.revision` label must equal `--expected-core-revision`.
The command runs it with no network, a read-only root filesystem and no
capabilities, checks the Wasm against the image's `.sha256` and the WebAssembly
component header, and writes `build-receipt.json`
(`dogeos/cubesigner-policy-build-receipt/v2`: compiler image, core revision,
Wasm path, sha256 and size) next to the Wasm. Keep each generation in a new
directory.

`PROOF_RESOLVER_BASE_URL` below must equal the artifact origin and base path
compiled into that release's policy, and the generated WP
`proof_system.signer_proof_artifact_base_url`, normalized to end in `/`.
For S3 this includes the configured key prefix, for example
`https://<bucket>.s3.<region>.amazonaws.com/<deployment-prefix>/`.
Proof references contain logical keys; the storage layer adds that prefix.
Using only the bucket root when a prefix is configured produces a URL mismatch.
This is not a signed URL or the DA archive's independently configured public
base.

The CubeSigner organization must also permit HTTP egress to this resolver.
Preview the addition, then apply the reviewed change:

```bash
scrollsdk setup cubesigner-policy resolver \
  --base-url "$PROOF_RESOLVER_BASE_URL" --organization "$CUBESIGNER_ORG_ID" --json
scrollsdk setup cubesigner-policy resolver \
  --base-url "$PROOF_RESOLVER_BASE_URL" --organization "$CUBESIGNER_ORG_ID" \
  --apply --output .data/cubesigner-policy-resolver.json --json
```

This uses the existing management session and preserves all other allowed
authorities and configuration fields. The setting applies to the organization;
it is separate from the bucket's anonymous read policy. Provider readback
confirms the configuration, while a hosted policy request must still verify
actual HTTPS delivery. The provider has no atomic compare-and-swap API: serialize
organization configuration changes during this step. Without `--apply`, the
command performs read-only inspection.
The management identity must be authorized to update organization settings;
read access or ownership of a signing key is insufficient. HTTP 403
`UserRoleUnprivileged` requires an organization administrator to perform the
change. Do not treat testnet proof-failure fallback as evidence that the resolver
is reachable.

```bash
scrollsdk setup cubesigner-policy deploy \
  --build-receipt .data/cubesigner-policy-build/build-receipt.json \
  --build-receipt-sha256 "$POLICY_BUILD_RECEIPT_SHA256" \
  --name "$POLICY_NAME" --organization "$CUBESIGNER_ORG_ID" \
  --key-id "$CUBESIGNER_KEY_ID" \
  --output .data/cubesigner-policy-deployment --json
```

This command is a limited creation/attachment path, not the Council-governed
upgrade workflow for an existing key with `RequireRoleSession`. It has no
approval replay option and refuses an existing multi-policy attachment. For
release-specific external builds and governed upgrades, use the
[external policy runbook](cubesigner-external-policy.md) and Core governance tools.

This command performs remote writes using the current `cs` login. It verifies
the uploaded Wasm SHA-256, invokes the hosted policy to reject an empty request,
attaches a concrete version (including the provider's initial `v0`), and verifies
the key policy by readback. CubeSigner returns the canonical
`NamedPolicy#…/vN` on the key, so the command resolves and verifies that provider
ID as well as the readable `name/vN`; the attachment receipt records both.
An unrelated existing policy causes a refusal before
upload; use an explicit migration workflow for that case. The saved upload
receipt permits retry after interruption without creating another policy.

Build/deployment receipts establish compilation and attachment only. They are
not replacements for the production policy release and live-evidence receipts
required by `deployment-preflight`: validate actual proof retrieval, a valid proof,
invalid proof rejection, and the native signing route. Testnet's post-structural
proof fallback must not be recorded as strict proof-verification success.

## Upload and deploy

Selectively upload the required Secrets with `scrollsdk setup push-secrets`,
using the intended backend, AWS region and prefix where applicable. The order is
`prep-charts` → `gen-secrets` → selective `push-secrets`. Follow the proof AWS
runbook for separately managed proof tokens.

Apply the reviewed Helm values through the deployment environment's rollout
procedure: core configuration and nodes, contracts, dependent services, and
partner signer handoff. Complete the signer handoff before enabling Withdrawal
Processor proposals for the new protocol. Mock proof generation is internal to
Proof Coordinator; it does not require a separate mock worker.

For an enforcing deployment, the deployment is **not accepted until**
`scrollsdk setup deployment-preflight --proof-live --kube-context <context> --namespace
<namespace>` passes after the rollout. It requires the published kit and a fresh
authenticated TSO poll (within the last 60 seconds) from every Attestation
signer in the WP `tsoSigners`. A failure means liveness, not safety: an
enforcing WP with offline signers stalls signing; it never signs anything
wrong.

Where genesis hold is enabled, release it with the environment's `start-l1-sync`
operation after service/signer readiness, then verify synchronization, L2
progress, DA and ingress. Configuration generation and static proof checks alone
do not establish runtime readiness or transaction/proof acceptance.

After public bootnode Services have usable LoadBalancer endpoints, run
`scrollsdk rpc export --dogeos-rpc-package-dir /path/to/dogeos-rpc-package
--namespace YOUR_NAMESPACE` from this deployment directory using the intended
cluster's kubeconfig. Then start and verify the external RPC node. Public P2P
values preparation does not itself deploy the bootnodes or establish peering.

## Existing instances

For configuration cleanup on an existing instance, follow
[Updating an existing deployment directory](config-cleanup.md#updating-an-existing-deployment-directory).
Do not recreate identities, genesis or Bridge as part of a configuration refresh.
