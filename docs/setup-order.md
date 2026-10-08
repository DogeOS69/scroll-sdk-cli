# CLI setup order

This guide describes the dependency order of the CLI setup commands for a new
DogeOS instance with native Reth genesis. Run them from your deployment directory
with the current built/installed CLI and matching release inputs. It is not an
infrastructure bootstrap script or evidence of production deployment acceptance.
Provision the RPC endpoints, Kubernetes infrastructure, DNS, signer access and
storage required by your chosen deployment separately.

See [Local setup-order validation](setup-order-validation.md) for executed checks,
findings and the cloud/proof/runtime steps that remain unverified.
The newer [production input review](production-inputs-review.md) records the
cross-repository corrections and shadowfork configuration rehearsal.

Bridge initialization uses **`scrollsdk setup bridge-init`** with the configured
Dogecoin network's actual funding and confirmation process.

## 1. Prepare configuration and identities

Prepare the deployment layout before running setup. A lone `config.toml` is not
sufficient for chart preparation. Use the matching `scroll-sdk` release's
`examples/values/`, `examples/withdrawal-processor/` and
`examples/proof-coordinator/` as the starting templates, and supply the
deployment's reviewed `Makefile`. Keep the native TOML files at
`withdrawal-processor/WithdrawalProcessor.toml` and
`proof-coordinator/ProofCoordinator.toml`. `prep-charts` updates those files;
it does not bootstrap all application templates from an empty directory.
Select the services, node counts and chart versions in the Makefile for this
deployment. Keep command logs outside the deployment directory (or list their
paths in `.scrollsdkignore`), since configuration generation detects concurrent
changes to its input files. Local `.data/contracts-build` caches can also be
excluded; required configuration and proof materials must remain included.
Copy templates only when creating the directory, before generating identities
or artifacts, so later copies do not overwrite generated values.

Start from `scroll-contracts/docker/templates/config.toml` and fill the required
environment inputs, including an explicit `accounts.OWNER_ADDR`. See
[Configuration cleanup](config-cleanup.md) for supported fields and image pins.
Configure the following before generating genesis or initializing Bridge:

| Inputs | Commands | Dependency |
| --- | --- | --- |
| Deployment/activity accounts | `scrollsdk setup gen-keystore --accounts`; add `--activity-helper` if needed | Preserve the selected owner; an empty owner defaults to deployer. |
| Dogecoin RPC, Ethereum DA and domains | `scrollsdk setup doge-config`, then `scrollsdk setup domains` | Use the intended network and service endpoints. |
| Application signers | `scrollsdk setup eth-da-submitter`; `scrollsdk setup fee-oracle` | Select local or AWS KMS signing in each command. Configure DA archive settings; the fee oracle public address is needed for genesis. |
| Reth node identities | `scrollsdk setup l2-sequencer-reth --index 0`; `scrollsdk setup l2-bootnode-reth` | Configure additional instances as needed; see [Pure Reth configuration](reth-only-peers.md). |
| Attestation signer inputs | Each signer operator runs `scrollsdk signer init --id <id> --network <network>`, then `attestation_signer --print-identity` and `scrollsdk signer init ... --identity <file>` on their own infrastructure to produce the descriptor (attestation + transport public keys, no endpoint: signers dial out to the TSO), then the bridge operator runs `scrollsdk setup attestation-signer` | Collect the public descriptors in `descriptors/` or pass `--descriptor` for each file. This signer identity flow is independent of DA/Fee Oracle KMS provisioning. |
| TEE identity and session | `scrollsdk setup cubesigner-init`, then `scrollsdk setup cubesigner-refresh` | Use the intended CubeSigner environment and identity lifecycle; gamma is not a universal requirement. |

These are configuration tasks, not a script to rerun blindly on an existing
instance. Select the signer backends and instance counts for your environment.
Prepare matching proof image tools/material inputs for the selected release;
Bridge-bound real materials must be completed after protocol context exists.

For non-interactive commands, pass `-N --json` only where supported and supply
the required flags. `attestation-signer` and `signer init` use explicit inputs
and `--json`, without `-N`. CubeSigner setup requires a prior `cs login`;
`cubesigner-init -N` requires `--doge-config` and either `--roles` or
`--new --role-prefix`. `cubesigner-refresh -N` also requires `--doge-config`.

After `setup domains`, verify the RPC endpoints used by both the operator and
the service network. In regtest, domains projects the public Dogecoin ingress
URL into `doge-config.rpc.url` and `setup_defaults.toml.dogecoin_rpc_url`.
If using a directly reachable local RPC instead, configure that endpoint before
Bridge setup. It must also be reachable from the Bridge tools container.

## 2. Generate native L2 genesis

```bash
scrollsdk setup gen-l2-artifacts
```

The generator, deployer and verification images use `gen-configs-<revision>`,
`deploy-<revision>` and `verify-<revision>` with the same approved release tag or full contracts revision. The default is `dogeos-v0.3.0-rc.3`.
Choose a new deployment salt for a new instance. Owner and index-0 Reth signer checks must pass first. This produces
`values/genesis.yaml`, which Bridge preparation consumes.

For local contract development, use `--contracts-source /path/to/scroll-contracts`
instead of building the generator Docker image. This option applies to contract
artifact generation; Bridge initialization still uses its own tools image.

## 3. Initialize Bridge using the CLI

```bash
scrollsdk setup bridge-init
```

Select the Bridge tools image matching the intended core release with
`--image-tag` or the interactive prompt. This is a
`dogeos69/bridge-genesis-tools` tag, not a contracts `gen-configs-*` tag.
The command's default `--step all` executes these stages in order:

| Stage | Explicit command | Purpose |
| --- | --- | --- |
| 1 | `scrollsdk setup bridge-init --step 1-prepare` | Extract genesis and prepare protocol seed inputs. |
| 2 | `scrollsdk setup bridge-init --step 2-setup` | Generate setup outputs and broadcast the setup transaction. |
| 3 | `scrollsdk setup bridge-init --step 3-bridge-info` | Generate namespace and Bridge information. |
| 4 | `scrollsdk setup bridge-init --step 4-fund` | Broadcast the configured funding and/or deposit-seed transactions. |
| 5 | `scrollsdk setup bridge-init --step 5-protocol-context` | Generate protocol context for downstream services. |

Use either the full command or the individual stages, not both in succession.
When executing stages separately, use the same selected image tag throughout.
Non-interactive preparation requires `--seed`; preserve the instance's seed and
outputs privately. Setup and funding stages broadcast transactions and are not
idempotent. Resume from the appropriate stage after inspecting existing outputs
and transactions, rather than restarting the full initialization.

Provide valid funding inputs and satisfy the selected network's confirmation
requirements. Bridge outputs, including `.data/protocol_context.json`, must exist
before preparing dependent service values and Secrets.
The funding inputs are `base_funding_utxos` in `.data/setup_defaults.toml`; replace
the template placeholders with confirmed, unspent outputs controlled by the
helper derived from this instance's seed. Stage 1 returns the compressed-P2PKH helper funding address without exposing
the seed. Ethereum DA height discovery defaults to a temporary Kubernetes curl
pod; configure the intended cluster, or explicitly use
`--ethereum-da-probe direct` when the operator machine can reach the configured
RPC. Direct mode queries the actual height and fails on an unreachable RPC.
The cluster mode's fresh Ethereum devnet fallback to start block zero is not a
successful cluster/RPC check.

After successful stage 2, the CLI records both replay start heights and sets
`defaults.freshGenesisInit = true`. `prep-charts` projects this explicit new-bridge
state into both WP and L1I. Existing deployments default to false when this field
is absent; a snapshot continuation cannot also request fresh-genesis
initialization. Regenerating protocol context alone does not enable it.

## 4. Prepare proof and service configuration

Follow the [Proof operator runbook](proof-operator-runbook.md) for the selected
proof mode. For AWS storage, its dependency order is:

```text
eth-da-submitter archive configuration
  → setup proof-aws-init
  → setup proof-materials
  → setup doge-config --proof-topology
```

Reuse existing material receipts only when they match the release and instance
inputs. Real proof materials require the Bridge context and baking process
described in [Proof material preparation](proof-materials.md).
`proof-aws-init` requires the enabled canonical Ethereum DA S3 archive first;
it does not create the archive configuration from nothing. Non-interactive
`proof-materials --generation mock` requires explicit `--compiler-image` and
`--mock-worker-image` from the matching release. A skipped or failed proof setup
does not qualify the later policy export or `proof-config-check` to succeed:
configure an explicit topology even when the selected proof mode is disabled.

After all required Bridge and service signer inputs are ready:

```bash
scrollsdk setup prep-charts
scrollsdk setup gen-secrets
scrollsdk setup export-signer-policy
scrollsdk setup proof-config-check
```

Wait for `prep-charts` to finish before exporting the signer policy. If ingress
TLS is needed, run `scrollsdk setup tls` against the generated values and review
the final configuration before deployment. TSO and active Proof Coordinator
ingress use `TSO_HOST` and `PROOF_COORDINATOR_HOST`; see the
[ingress configuration notes](config-cleanup.md#active-ingress-hosts).

For Blockscout, run `scrollsdk setup db-init` only when its database or permissions
need initialization, before generating its Secrets and deploying it.
`BLOCKSCOUT_DB_CONNECTION_STRING` is the only retained database setting.

For external Reth/RPC nodes, run `scrollsdk setup bootnode-public-p2p` after
`prep-charts` creates the indexed bootnode values and before deploying those
bootnode releases. Identity generation alone does not enable public P2P.
The AWS command requires the cluster name and region; use
`--skip-controller-setup` when the controller is already managed by the
environment. See [Reth bootnode public P2P access](bootnode-public-p2p.md) for
the full command, controller setup and deployment boundary.

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
before rollout. The combined `proof-config prepare`/`publish` workflow still
requires the provisioned resource facts.

The standalone publisher does not modify the deployment contract. Bind its
receipt explicitly when regenerating values, then regenerate secrets:

```bash
scrollsdk setup prep-charts \
  --proof-materials-receipt .data/proof-materials-v1.json \
  --proof-publication-receipt .data/proof-program-publication-v1.json
scrollsdk setup gen-secrets
scrollsdk setup proof-config-check --json
```

For active/real deployments the final check also requires the artifact-store
resource receipt. Successful standalone publication does not satisfy that
separate requirement or any production signer evidence requirement.

## CubeSigner Wasm preparation and attachment

When the correctness signer uses the hosted verifier policy, generate an actual
Wasm after Bridge preparation. `export-signer-policy` generates the partner
attestation-signer handoff; it does not compile this CubeSigner Wasm.

```bash
scrollsdk setup cubesigner-policy build \
  --compiler-image "$POLICY_COMPILER_IMAGE" \
  --expected-core-revision "$CORE_REVISION" \
  --preparation-receipt .data/preparation/proof-release-preparation-v1.json \
  --protocol-context .data/protocol_context.json \
  --resolver-base-url "$PROOF_RESOLVER_BASE_URL" \
  --output .data/cubesigner-policy-build --json
```

The compiler image must be pinned by digest and match the preparation revision.
`PROOF_RESOLVER_BASE_URL` must equal the generated WP
`proof_system.signer_proof_artifact_base_url`, normalized to end in `/`.
For S3 this includes the configured key prefix, for example
`https://<bucket>.s3.<region>.amazonaws.com/<deployment-prefix>/`.
Proof references contain logical keys; the storage layer adds that prefix.
Using only the bucket root when a prefix is configured produces a URL mismatch.
This is not a signed URL or the DA archive's independently configured public
base. The command checks
the receipt/context identity and runs the compiler without network or a core
source checkout. Output contains the real Wasm, build receipt, compiler digest,
and input copies. Keep each generation in a new directory.

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
required by `proof-config-check`: validate actual proof retrieval, a valid proof,
invalid proof rejection, and the native signing route. Testnet's post-structural
proof fallback must not be recorded as strict proof-verification success.

## 5. Upload and deploy

Selectively upload the required Secrets with `scrollsdk setup push-secrets`,
using the intended backend, AWS region and prefix where applicable. The order is
`prep-charts` → `gen-secrets` → selective `push-secrets`. Follow the proof AWS
runbook for separately managed proof tokens.

Apply the reviewed Helm values through the deployment environment's rollout
procedure: core configuration and nodes, contracts, dependent services, and
partner signer handoff. Complete the signer handoff before enabling Withdrawal
Processor proposals for the new protocol. Mock proof generation is internal to
Proof Coordinator; it does not require a separate mock worker.

Where genesis hold is enabled, release it with the environment's `start-l1-sync`
operation after service/signer readiness, then verify synchronization, L2
progress, DA and ingress. Configuration generation and static proof checks alone
do not establish runtime readiness or transaction/proof acceptance.

After public bootnode Services have usable LoadBalancer endpoints, run
`scrollsdk setup gen-rpc-package --dogeos-rpc-package-dir /path/to/dogeos-rpc-package
--namespace YOUR_NAMESPACE` from this deployment directory using the intended
cluster's kubeconfig. Then start and verify the external RPC node. Public P2P
values preparation does not itself deploy the bootnodes or establish peering.

## Existing instances

For configuration cleanup on an existing instance, follow
[Updating an existing deployment directory](config-cleanup.md#updating-an-existing-deployment-directory).
Do not recreate identities, genesis or Bridge as part of a configuration refresh.
