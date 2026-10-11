# v0.3.0 branch integration decisions

The integration starts at `42a07f0` and incorporates PR #73's branch
`20b7e31` while preserving the current proof release, signer and dstack workflows.
PR #72's original head `21dbd42` and its squash commit `4cd42be` have identical
trees; branches contained in that historical head need no further code merge.

| Source | Resolution |
| --- | --- |
| `docs/pre-bridge-instance-preparation` and its three preceding fix branches | Integrate configuration/service retirement, Reth public P2P, local contracts generation, CubeSigner role validation, reused-role archive grants and setup documentation. |
| Older account-only `gen-keystore` implementation | Retain the current unified Reth/service identity entrypoint and explicit account selection. |
| Older contracts defaults and genesis preflight | Retain rc.3 defaults and owner/Reth signer checks; add the local Foundry backend and retire unused verifier prompts. |
| Retired database filtering | Preserve active Blockscout/dstack DSNs, passwords and selection flags; remove retired service settings. |
| Proposed `proof-aws-init --artifact-public-read-mode shared-s3` | Keep `existing-public-s3` plus the current `artifact-access` plan/apply workflow, which already handles scoped grants and drift checks. Do not reintroduce a second bucket-policy writer. |
| `feat/partner-attestation-signer` at `1b89949` | All code matches current ancestor `2b64cbc`; its only tree difference is the Chinese service runbook. Restore an updated runbook using the current APIs. |
| `feat/refactor_kms_tmp` at `1bbaf9a` | Retire the experimental Geth/deployment-state architecture. Preserve its original tip under a local archive tag; do not import the prototype commands. |

The KMS prototype's shared provisioning abstraction is already present in
`KmsSignerProvisionRole`. Current Reth commands and `gen-keystore` handle local
and KMS signing identities, node counts and existing-key validation in
doge-config; DA archive settings are also owned there. Secret generation and
publication use `gen-secrets` and `push-secrets` instead of the prototype's
immediate secret writer.

The prototype's `rotation.generation` counters, generic external-secret service
signer backend, and `l2-nodes --regenerate` interface are intentionally not
introduced. They require separate product decisions and migration design; their
presence on the old branch is not evidence that existing deployments use them.
Keeping the archive tag preserves those experiments for future work without
making a second runtime inventory authoritative.

Historical deployment reports retain their original validation scope. This
integration is checked by local builds and tests; it does not deploy services,
change cloud permissions or certify real GPU proof generation.
