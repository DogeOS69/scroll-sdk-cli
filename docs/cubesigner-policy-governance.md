# CubeSigner policy updates through governance

Status: **design proposal, not implemented**. This document specifies the CLI
integration for a publisher/proposer updating an existing governed TEE key.
It does not change CLI behavior or authorize a policy update. The proposed
commands below are not available yet.

## Existing behavior and the integration gap

[`setup cubesigner-policy build`](../src/commands/setup/cubesigner-policy/build.ts)
produces a bridge-specific Wasm and build receipt using a compiler image pinned
by digest. Inputs include the preparation receipt, protocol context, verifying
key commitments and resolver URL. A successful trial build is not automatically
suitable for another bridge or its production signer.

[`setup cubesigner-policy deploy`](../src/utils/cubesigner-policy-deploy.ts)
checks the receipt and Wasm, creates a named policy, verifies its initial version,
checks empty-request rejection, and immediately attaches that version. Its
preflight accepts an empty key policy or the same single policy reference; it
**refuses** a compound `RequireRoleSession` plus verifier policy. It does not
publish upgrades to an existing named policy or resume Council approval.

`setup plan` / `setup apply` do not currently orchestrate this governed policy
update. The [existing setup guide](setup-order.md#cubesigner-wasm-preparation-and-attachment)
remains the reference for implemented build/resolver/deploy commands.

## Roles and prerequisites

| Role | Responsibility | Where inputs come from |
| --- | --- | --- |
| DogeOS administrator / key owner | Bootstrap and seal the key, role, named policy, access lists and edit policies; approve the deployment's governance configuration | Reviewed organization and Council setup |
| Policy publisher | Reproduce the verifier build and publish an immutable version | Approved source revision, build recipe and deployment inputs |
| Authorized proposer | Submit the exact key policy change, wait for approval, execute it and verify the result | Administrator-provided object references and the published version |
| Council members | Independently reproduce/check the Wasm and review the exact request; approve or reject using their own accounts | One shared review packet and CubeSigner pending request |
| Signer operator | Use the approved role session and refresh deployment evidence when required | Verified attachment and the production signer runbook |

One person may hold publisher and proposer permissions when explicitly granted.
The CLI must use the real edit policy's threshold and approvers, not hard-code
the trial's 2-of-2. Publishing a version needs no Council approval under the
intended policy scopes; attaching it does. Unexpected approval requirements on
publication indicate a configuration issue to investigate.

The initial administrator workflow stays in the upstream governance tool. Its
reviewed setup configures objects while unregistered and unfunded, seals them
last, and verifies them before bridge registration. A daily publisher does not
need organization administration rights. Resolver HTTP-egress configuration is
an administrator prerequisite, separate from publishing or attaching a version.

Each person authenticates with their own `cs` management session. The CLI must
never collect another person's password, MFA code or session, approve on behalf
of the Council, or elevate a publisher into an organization administrator.

## Proposed operator flow

Use the deployment directory as the default working directory. Import the
administrator's reviewed public object configuration once as
`cubesigner-governance.json`: environment, organization, key, role and named-policy
IDs, plus the expected governance constraints. Validate its references against
CubeSigner. Do not ask the operator to discover and repeatedly type these IDs.
The exact import/schema adapter remains an implementation decision.

Prepare the deployment-specific build using the existing build command and its
approved inputs. Allocate a new directory for each update, such as
`policy-updates/001`; never overwrite a previous update. The following is a
**proposed interface**, not a runnable runbook:

```text
scrollsdk cubesigner policy publish --update-dir policy-updates/001 --build-receipt .data/cubesigner-policy-build/build-receipt.json
scrollsdk cubesigner policy propose --update-dir policy-updates/001
scrollsdk cubesigner policy status --update-dir policy-updates/001
# Council members independently review and approve using their own tooling.
scrollsdk cubesigner policy resume --update-dir policy-updates/001
scrollsdk cubesigner policy verify --update-dir policy-updates/001
```

| Step | Required behavior and output |
| --- | --- |
| Build and publish | Validate build provenance and artifact hash; publish to the existing named policy; record and read back its canonical ID, exact version and Wasm hash. The key keeps its previous policy. |
| Propose | Preview the complete current and proposed key policies. Preserve `RequireRoleSession` and other reviewed constraints; reject unrecognized policy structures. Submit only the reviewed request and record every returned approval request ID. |
| Council review | Deliver the shared packet through Governance or another authenticated channel. Approvers compare the provider request with the packet and independently rebuilt Wasm before approving. |
| Status | Read request state and current attachment. Distinguish pending, approved, rejected, expired, executed, and unknown/unavailable; surface authentication and permission errors separately. |
| Resume | Confirm the request is still applicable and approved. Execute the identical request with the matching approval confirmations. Approval alone does not execute the attachment. |
| Verify | Read the key and policy version, verify the signed key attestation, and compare the role constraints and Wasm hash with the reviewed target. Save evidence and the next shared expected-state snapshot. |

Mutation commands should preview by default and require an explicit execution
option, such as `--apply`, to publish, propose or resume. The example above lists
stages without those execution options. Status and verification never mutate
CubeSigner; verification may write local evidence. Each result should identify
the next action, who performs it, and which packet/request to share.

## One shared review packet

Each update directory holds an immutable proposal and build manifest, followed
by append-only request/outcome evidence. A single canonical packet is shared
with the Council; local tool state is a cache, not a separate expected truth.
The minimum review material is:

- Environment and organization; key, role and canonical named-policy IDs;
  exact previous and target policy arrays, including the target version.
- Source revision, reproducible build command/toolchain, compiler image digest
  when used, and hashes of all deployment-specific build inputs. Include the
  Wasm SHA-256 and size, not just a human-readable version name.
- Exact provider operation and request body, the reviewed governance config
  snapshot, a digest binding the proposal and build manifest, and the previous
  approved packet reference.
- Every approval request ID and its relationship to the proposal; publication,
  submission and final verification evidence, with collection timestamps.
- The verified attestation and provider verification material needed for later
  audit, together with the matching expected-state snapshot.

Provide authorized reviewers the source, recipe and non-secret inputs needed
to reproduce the artifact; hashes alone are insufficient. Resolve review input
locations from the packet, without requiring reviewers to reconstruct paths
from a publisher's machine. The fixed build path and pinned toolchain/WASI SDK
from the upstream reproducibility work must be respected where applicable.

Governance can distribute or reference the packet and its digest. Its exact
storage, authentication and API integration need agreement with the Portal
maintainer; this proposal does not claim that integration already exists.
Keep packets in the operator workspace or approved governance storage. Do not
commit deployment evidence wholesale to a public repository. Never include
management/role sessions, credentials or MFA confirmation tokens in the shared
packet; obtain execution confirmations through the authenticated provider.

After successful verification, publish a new expected-state snapshot derived
from the verified result, linked to the immutable approved proposal. Do not
rewrite the original review target. Verification must use this shared snapshot
and live CubeSigner state, rather than another operator's stale local state.
Historical attestations establish state at their collection time, not today.

## Interruption, drift and concurrency

- Serialize writers per key. Record the expected previous attachment and
  re-read it before proposing/resuming; stop on drift instead of replacing a
  policy changed by another operator. Local locking alone cannot serialize
  independent machines, so the operational procedure must assign one writer.
- If publication or submission times out, reconcile provider state and saved
  evidence before retrying. Do not create another version or pending request
  merely because a local success response is missing. If the provider cannot
  establish the outcome, stop for operator reconciliation.
- A request owner or another operator may lack permission to read a pending
  request. Report that limitation; an inaccessible request is not proof that
  no request exists or that it was rejected. Do not automatically resubmit.
- Resume uses the saved exact operation, environment, object IDs, version and
  body. A changed target requires a new reviewed proposal. Rejected/expired
  requests cannot be reused; retain their history and explicitly supersede them.
- Keep Council membership/edit policies unchanged while replaying approvals.
  Reject pending requests before changing the Council, as required by the
  upstream runbook; do not assume an older approval is invalidated by that edit.
- If the intended policy is already attached after a crash, verify and record
  completion. Do not attach again or invent an approval history that was not
  captured. Permission denial and incomplete evidence remain visible outcomes.

## Reuse upstream tooling and integrate deployment preparation

Reuse Daniel's TypeScript governance tooling for publication, attachment,
approval handling and signed-attestation verification. Pin a reviewed revision
and adapt its config/state interface rather than maintaining a second provider
implementation. Its current local state/log files need an adapter to the shared
packet model above; this is an integration gap, not an upstream feature claim.
Account for its SDK version separately from this CLI's current dependency.

The CLI wrapper should preserve provider approval IDs and distinguish upstream
authentication errors, approval-pending results and other failures. It must not
turn a pending approval into success or repeat a mutation automatically.

Future spec/apply integration should reference an administrator-provided
governance configuration and a verified policy update. If attachment approval
is required, pause the dependent preparation step with a precise next command
and resume after verification. A routine repeat of `apply` must not publish a
new version, create trial objects, or submit duplicate approval requests.
Policy changes should remain an explicitly selected operation.

The verified result must be mapped to the existing policy release/deployment
and live-evidence requirements used by `proof-config-check`; those schemas and
refresh rules need implementation review. Successful attachment is not proof
of resolver reachability, valid-proof acceptance, invalid-proof rejection or
native signing readiness. Trial/testnet proof-failure fallback is not production
acceptance. Retain those separate checks and the intended signer image/input
compatibility. Initial `v0` accepted by today's deploy command is not sufficient
for the production signer's upstream readiness requirement (`v1` or later).

## Implementation acceptance and source references

Before implementation is considered complete, rehearse an upgrade using separate
publisher/proposer and Council sessions. Cover reproducible builds, unchanged
attachment after publish, rejection of a mismatching build, preserved role
constraints, approval without execution, interrupted resume, duplicate retries,
concurrent drift, unauthorized request lookup, and agreement between two
operators verifying the same packet. Confirm the governed path requires no
organization-administrator privileges for daily publication/proposal.

This design uses the upstream governance tool reviewed at
[`e3d20388c`](https://github.com/DogeOS69/dogeos-core/tree/e3d20388c372db7d632984de3d8f619ee5f3d457/tools/cubesigner/governance),
from [dogeos-core #1495](https://github.com/DogeOS69/dogeos-core/pull/1495).
Its [operations runbook](https://github.com/DogeOS69/dogeos-core/blob/e3d20388c372db7d632984de3d8f619ee5f3d457/docs/runbooks/cubesigner-tee-key-operations.md)
and [reproducible build script](https://github.com/DogeOS69/dogeos-core/blob/e3d20388c372db7d632984de3d8f619ee5f3d457/tools/cubesigner/build-verifier.sh)
are the starting points for implementation. Recheck their final merged behavior
and the production build inputs before selecting an integration revision.
