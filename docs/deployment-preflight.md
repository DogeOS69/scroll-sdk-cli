# Deployment preparation and checks

Use the current scroll-sdk example templates and the matching scroll-sdk-cli.
The templates target the supported release; the CLI does not migrate historical
configuration. These commands check current deployment inputs, reconcile artifact
permissions and validate signer routing. Run them from the deployment directory.

## 1. Prepare and reuse the CubeSigner identity

Create the intended role/key and session with `setup cubesigner-init` and
`setup cubesigner-refresh`. Existing local files can be reused directly when
continuing in the same deployment directory. For optional backup and recovery
before archiving/replacing deployment inputs, use the `cubesigner` maintenance
group:

```bash
scrollsdk cubesigner checkpoint --action export \
  --directory .data/private-cubesigner --instance devnet-instance \
  --organization 'Org#YOUR_ORGANIZATION' \
  --signer-api-root https://gamma.signer.cubist.dev --json

# Later, from the same deployment root or a prepared new root:
scrollsdk cubesigner checkpoint --action import \
  --directory .data/private-cubesigner --instance devnet-instance \
  --organization 'Org#YOUR_ORGANIZATION' \
  --signer-api-root https://gamma.signer.cubist.dev --json
```

The checkpoint contains signing credentials. Exclude the directory from version
control. Files are created with mode 0600 in a 0700 directory. Export refuses an
existing output directory; import verifies hashes, instance, signing API origin,
organization, role/key/public key, session expiration and refresh expiration.
Import preserves unrelated config and policy selection, rejects another active
TEE identity, and makes no CubeSigner provider calls. It does not establish that
a locally valid session remains unrevoked. If the signing session is expired,
use `setup cubesigner-refresh`; a checkpoint cannot extend its lifetime.

## 2. Generate and check current configuration

Start with the current `scroll-sdk/examples` templates. The WP template uses
current native fields, and `prep-charts` derives the DA batcher allowlist from the
submitter signer. Set `cubesigner.mode` explicitly in the source configuration:
`transport_only` is available on non-mainnet with either `observe` or `enforce`.
WP proof enforcement and CubeSigner proof verification are independent choices.
Use WP's `plain` correctness-policy transport with a `transport_only` signer.
Mainnet requires `production_verifier_key_policy` and matching `policyReceipts`.
The CLI's bundled
devnet DeploymentSpec templates select `transport_only` explicitly. The SDK's
production CubeSigner values retain the production policy posture.

```bash
scrollsdk setup prep-charts -N --json
scrollsdk setup proof-config-check --json
scrollsdk setup deployment-preflight --json
```

`deployment-preflight` is read-only. It checks the contract owner signing
configuration, the fixed 42,069,000 sat genesis sequencing output, WP fees, the DA batcher allowlist,
the relationship between chunk gas and genesis block gas, CubeSigner policy
selection, and dstack configuration. It consumes doge-config and conventional
values/native paths. It does not rewrite configuration, choose a release, inspect
live database schemas or perform database recovery.

`setup gen-keystore --accounts` fills an empty owner with the deployer address;
an explicit owner is preserved. Missing local owner signing access is reported
as a warning because externally controlled wallets and multisigs are supported.
Confirm those wallets can sign before deploying. Invalid or zero owner
addresses and locally supplied mismatching keys are errors.

After replacing a Bridge, a hosted CubeSigner policy must be rebuilt and
attached for the new protocol context even in `transport_only` mode. If policy
receipts are supplied, generation checks their release, attachment and current
`.data/protocol_context.json` binding. Without attachment receipts it explicitly
reports remote policy state as unverified; it cannot discover remote policies
from local configuration alone. `transport_only` does not require C2F egress.

## 3. Reconcile each new artifact prefix

`proof-aws-init --artifact-public-read-mode existing-public-s3` intentionally
preserves the bucket policy. It does **not** imply a new prefix is readable.

The DA archive (`ethereumDa.blobArchive.s3`) and the bootstrap snapshot bucket
(`snapshots.s3`) are managed by `setup artifact-access --store da|snapshot`.
The proof artifact bucket (`proofArtifacts.s3`) is managed by
`proof-aws-init`. Each bucket has one writer:

```bash
# Plan, then apply the reviewed changes:
scrollsdk setup artifact-access --store da --public-read \
  --writer-role-arn arn:aws:iam::123456789012:role/eth-da-submitter --json
scrollsdk setup artifact-access --store da --public-read \
  --writer-role-arn arn:aws:iam::123456789012:role/eth-da-submitter --apply --json

# Read-only policy/IAM checks before starting the workload:
scrollsdk setup artifact-access --store da --public-read \
  --writer-role-arn arn:aws:iam::123456789012:role/eth-da-submitter --check --json

# DA kill switch: remove public reads; our services keep reading through the
# S3 VPC endpoint statement.
scrollsdk setup artifact-access --store da --no-public-read --apply --json

# Snapshots: deploy role writes; public read stays off unless requested.
scrollsdk setup artifact-access --store snapshot \
  --writer-role-arn arn:aws:iam::123456789012:role/deploy --apply --json
```

The command enables versioning and owns three bucket-policy statements by Sid:
`ScrollSdkDenyInsecureTransport` (TLS-only), `ScrollSdk<Store>ReadViaVpcEndpoint`
(GetObject from the S3 Gateway endpoint recorded by `proof-aws-init`, or
`--vpc-endpoint-id`), and `ScrollSdk<Store>PublicRead` (anonymous GetObject,
added by `--public-read`, removed by `--no-public-read`). The DA writer inline
policy `eth-da-submitter-s3-archive` grants GetObject/PutObject on the DA
prefix and on the proof store's `scroll-chunk-segmentation-sidecars/` namespace;
the snapshot writer gets PutObject only. No list or delete is granted. Other
statements are preserved, even explicit Deny statements. Policy changes observed
between planning and writing stop the operation. AWS has no bucket-policy
compare-and-swap; serialize concurrent policy updates.

The plan fails closed, before any write, when:

- another statement grants anonymous access to the prefix (for example a legacy
  `ScrollSdkArtifactRead*` grant from the previous `artifact-access`, or a
  public write). Remove it from the bucket policy yourself; the CLI never
  deletes statements it does not own;
- public read would be off but no usable VPC endpoint read statement exists
  for the prefix: the endpoint must be an available S3 Gateway endpoint in the
  bucket's region (supply it with `--vpc-endpoint-id` if none is recorded).

`--check` also fails when the managed writer inline policy differs from the
planned one (for example the old bucket-wide grant, or an extra DeleteObject).
It does not audit other policies attached to the role.

The command checks bucket/account public policy restrictions before adding a
public statement. If the account disallows public policies, have its owner
configure delivery or use an existing gateway.

`--check` requires the exact CLI-managed public statement; equivalent arbitrary
operator statements are not inferred. Writer checks use IAM simulation. These
checks cannot certify effective live access through every SCP, endpoint, bucket,
KMS or gateway policy. Verify anonymous GET on actual required artifact objects
and a write/read from the real workload after deployment. A successful policy
write is not reported as runtime acceptance.

Previously parked archive jobs remain a submitter/operator recovery concern.
Fixing IAM does not rewrite their retry state, and there is no CLI SQL repair
command.

## 4. Check signer-host Docker routing

Run on **each Docker signer host**, against the Docker daemon used by Compose:

```bash
scrollsdk signer network-check \
  --cluster-cidr 192.168.0.0/16 \
  --proposed-subnet 10.253.12.0/24 --json
```

Pass the deployment's actual VPC/pod/service IPv4 CIDRs, repeating the flag as
needed. This example is not a universal subnet allocation. The command includes
unused Docker networks: an old network with zero containers can still install a
route that captures EKS replies. It also checks a proposed subnet against all
existing Docker networks. It does not validate IPv6 or every host/VPN route.

Resolve collisions by assigning non-overlapping explicit Compose IPAM. Remove
old networks only after checking ownership and attached containers. The CLI
never deletes networks or restarts partner signers.

## 5. Require and verify the Kubernetes dstack controller

Follow [the dstack controller guide](dstack-controller.md) to import credentials,
prepare its database, generate/upload Secrets and install the separate chart.
Mock proof generation does not require a GPU, but deployments intending to use
the dstack architecture should explicitly include this gate:

```bash
# Require source configuration and generated controller values:
scrollsdk setup deployment-preflight \
  --require-dstack --json

# After controller installation, require its current Deployment to be available:
scrollsdk setup deployment-preflight \
  --require-dstack --kube-context YOUR_EXPLICIT_CONTEXT \
  --namespace default --dstack-deployment dstack-controller --json
```

Without `--kube-context`, no Kubernetes calls occur and runtime is reported as
`not-checked`. With it, the command checks updated/available replicas and observed
generation, without mutations. Customize namespace/deployment for chart name
overrides. This is Deployment availability, not provider authentication, GPU
allocation, worker readiness or proof acceptance. Controller installation and
GPU fleet/task submission remain separate actions.
