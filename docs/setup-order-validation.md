# Local setup-order validation

Validated on 2026-09-11 against the working CLI and contracts revision
`dd1747862ee11e5feab45ca76c462957fb0d8bfa`. This records the scope of the local
rehearsal, not production or cloud deployment acceptance.

The evidence directory for this run is
`/tmp/scrollsdk-setup-order-51jYn9r2`. The first pass used `deployment/`; a second
pass created `replay/deployment/` from the templates, without copying generated
identities, genesis or Bridge outputs from the first pass. Both used only local
test accounts and an isolated Dogecoin regtest node. The second pass reused that
local Dogecoin node, with a different Bridge seed, fresh funding and new L2 salt.

## Executed scope

| Area | Result | Limits |
| --- | --- | --- |
| Accounts, doge-config, domains | Passed through CLI subprocesses | Integer Ethereum DA chain ID included; local RPC restored after regtest domain projection. |
| DA/Fee Oracle signing | Passed with generated local keys | AWS KMS provisioning was not exercised. |
| Reth sequencer/bootnode identity | Passed | One sequencer and one bootnode; no running multi-node consensus test. |
| Attestation identity and descriptor import | Passed | Locally generated descriptor; external signer service was not started. |
| CubeSigner init/refresh | CLI configuration passed with an offline provider double | No real login, key provisioning, session authentication or signing was verified. |
| L2 artifacts | Passed using `--contracts-source` | Both passes generated from the contracts source; no generator image build required. |
| Bridge stages 1–5 | Passed using real `bridge-genesis-tools:v0.3.0-beta.4f` | Local regtest only. The CLI used its documented Ethereum devnet start-block-zero fallback; Kubernetes/DA reachability was not verified. |
| Bridge transactions | Independently verified 11 confirmed transactions for each Bridge | Setup plus ten configured funding/deposit transactions, all on the isolated regtest node. |
| Reth genesis initialization | Passed using `rollup-node:tsuki-5bce327d-reth-39b31f82` | Genesis initialization only, not service readiness or release compatibility certification. |
| Contracts deployment | Passed on temporary Anvil initialized from generated genesis | Verified nonempty bytecode at 31 addresses, read back 16 state entries, and checked all five owner results against `OWNER_ADDR`. |
| Ordinary chart preparation and Secrets | Passed | Proof topology was absent; this does not verify compiled proof configuration. |
| TLS and Helm rendering | Passed for local TLS generation and TSO/Reth rendering | Issuer discovery used a test double; no certificate issuance, DNS or Kubernetes installation. |
| Proof AWS/materials/topology, policy export and proof validation | Prerequisite failures recorded | Missing canonical archive, matching proof material inputs and compiled deployment contract. No proof acceptance claimed. |
| Secret upload | Missing-region validation exercised | No secrets uploaded to AWS. |
| Blockscout DB initialization, service rollout, signer handoff, L1-sync release | Not executed | No database or runtime environment was provisioned for these optional/environment-dependent operations. |

The fresh-directory replay completed 19 CLI invocations successfully through
Bridge and ordinary configuration generation. Two of those invocations used the
CubeSigner provider double. The replay deliberately tested ordinary chart
consumers independently after Bridge; it did not complete the proof section of
the setup guide.

## Corrections found during execution

- `setup doge-config -N` crashed on a TOML integer `ethereumDa.chainId`. Text
  defaults now normalize that value before resolving environment references.
- `prep-charts` assumed `metricsConfig.rollup` existed, while the current SDK
  metrics template had already removed it. Preparation now removes old rollup
  settings and handles the current template.
- `export-signer-policy` dereferenced an absent proof intent. It now reports the
  missing topology and the setup commands required to provide it.
- The guide incorrectly grouped `signer init` with DA/Fee Oracle KMS setup and
  omitted the Makefile/application-template prerequisites. Both are corrected
  in [CLI setup order](setup-order.md), along with non-interactive flags,
  funding inputs, RPC reachability and proof prerequisites.

Automated regression validation: 563 passing, 13 pending. The pending tests are
not counted as exercised coverage. Changed-file ESLint: zero errors and five
complexity warnings. Build and whitespace checks passed.

Evidence includes `results.jsonl`, `replay/results.jsonl`, per-command logs,
`bridge-confirmations.json`, `reth-init.log`, `contracts-deployment/evidence/`,
Helm renders and `regression-final.log`. Generated deployment directories contain
test private keys and a deliberately invalid CubeSigner session fixture; they
are test artifacts and must not be used as deployment credentials.

## Supplemental public bootnode validation

The initial 19-command replay omitted `setup bootnode-public-p2p`. The follow-up
at `/tmp/scrollsdk-bootnode-public-j4ndnFKy` executes that command with isolated
provider process doubles and adds 14 regression cases, including actual Reth
Helm rendering. The combined regression result is **577 passing, 13 pending**.

The original command returned exit zero but mixed logs into JSON stdout. The
fixed command returns parseable JSON, fails before cloud calls on missing
inputs, uses the selected EKS cluster for Helm/kubectl, and propagates injected
OIDC/IAM/readiness failures without updating local values. Controller setup
uses a matching chart/application IAM policy; an existing controller can be
reused explicitly. Public Service annotations use AWS controller ownership and
the TCP/UDP listener option. Legacy Service ownership requires a migration.

Using the first rehearsal's generated Reth inputs, the follow-up also verified:

- `prep-charts` preserves the public P2P values on regeneration.
- Real Helm rendering produces `l2-reth-bootnode-0-p2p` as a LoadBalancer with
  only TCP/UDP 30303; RPC and metrics stay on the internal Service.
- A complete `gen-rpc-package` run with RPC-package repository Compose/scripts
  writes the simulated public LB hostname into the external peer list.

AWS resources, actual NLB readiness and external-node network connections were
not exercised. See [Reth bootnode public P2P access](bootnode-public-p2p.md) for
the operator sequence and the boundary between configuration and rollout.
