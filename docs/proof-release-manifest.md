# Proof release manifest contract

`dogeos/proof-release/v1` is the release-producer input used by
`scrollsdk setup doge-config --proof-topology`. Deployment operators select a
manifest; they do not transcribe its image digests, program identities, or
file hashes into configuration prompts.

The manifest is immutable for one `releaseId` and contains:

- the dogeos-core proof-topology compiler image and digest;
- separate mock-capable and production Worker images and digests;
- the operator profiles supported by that release;
- release-relative chunk, batch, bridge, L2-range-aggregation, aggregate-VK,
  and materializer file paths;
- a SHA-256 pin for every referenced release file;
- reviewed chunk, batch, bridge, and L2 range aggregation identities;
- stable backend profile and optional prover requirement identifiers.

The complete JSON shape is maintained at
`scroll-sdk/examples/.data/proof-release-v1.json.example`. Its placeholder
digests are documentation only and cannot pass material verification.

## Ownership boundary

The release producer owns all manifest values. The deployment operator owns:

- initial `disabled`, `mock`, or `production` selection;
- artifact infrastructure selection;
- production Worker placement;
- the release-material host directory and Kubernetes PVC;
- witness input selection;
- external Proof Coordinator and artifact endpoints when they cannot be
  derived from deployment state.

The CLI derives service ports and URLs, container mount paths, secret-file
paths, coordinator/Worker IDs, AWS store coordinates, and ordinary defaults.
The dogeos-core compiler then generates native WP/PC configs, Worker launch
contract, submitter patch, canonical topology digest, digest-scoped artifact
prefix, generated program manifests, and rollout plan.

## Validation

Initialization fails before changing `doge-config.toml` when:

- the manifest has an unknown field or unsupported schema/profile;
- an image is not pinned by a canonical `sha256:` digest;
- a release path is absolute or escapes the selected resources directory;
- a referenced file is absent, a symlink, or has another SHA-256;
- a VK or commitment has the wrong canonical encoding;
- the L2 range aggregation and bridge recursive VK identities disagree;
- the L2 range raw commitment does not hash to its declared identity;
- either mock or production compiler preflight fails.

The generated doge-config records:

```toml
[proof_release]
manifestPath = ".data/proof-release-v1.json"
manifestSha256 = "<lowercase SHA-256 hex>"
releaseId = "<release-producer ID>"
```

Every later doge-config proof compilation rechecks this binding, the expanded
release fields, and all referenced material hashes. Changing a manifest in
place is rejected; a release upgrade must rerun the explicit topology
initializer and both preflights.

## Normal deployment flow

```bash
# Receive the real pinned manifest and proof-artifacts directory from the
# release producer. Do not rename the .example file into service use.

scrollsdk setup proof-aws-init \
  --aws-region us-west-2 \
  --eks-cluster dogeos-testnet \
  --network-alias testnet

scrollsdk setup doge-config --proof-topology
scrollsdk setup prep-charts -N
scrollsdk setup proof-config-check --deployment-dir .
```

When `.data/doge-config.toml` already exists, the initializer runs as a
proof-only wizard and leaves its ordinary Dogecoin/DA configuration untouched.

After initialization, an ordinary transition changes only:

```toml
[proof_topology]
mode = "mock" # or production
```

Rerun `setup prep-charts` to compile the selected strict service
configuration. Do not edit generated WP, PC, Worker, or submitter files.
