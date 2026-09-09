# Devnet TLS and signer handoff checkpoint

The instance is still the new Bridge documented in
[the instance runbook](devnet-new-bridge-20260909.md). This is a partial handoff,
not end-to-end acceptance.

## TLS before signer callbacks

On 2026-09-09, EC2 could reach the TSO through HTTP, but verified HTTPS failed
with a self-signed certificate. DNS already pointed at the cluster ingress.
Do not use `curl -k` or change signer callbacks to unverified HTTP to hide this.

The CLI TLS command omitted Reth's current RPC values and did not accept an
explicit context. The repair includes `l2-reth-rpc` and `l2-reth-rpc-public`
and adds `--kube-context` to both issuer reads and creation. Arguments are passed
without a shell. A regression test covers Reth HTTP/WebSocket TLS, explicit
context retention and idempotent reruns; build and targeted lint pass.

Run from the deployment directory, after domains and chart configuration:

```bash
scrollsdk setup tls --non-interactive --cluster-issuer letsencrypt-prod \
  --kube-context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster --json
make install-tso
helm --kube-context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  upgrade -i l2-reth-rpc-public oci://ghcr.io/dogeos69/scroll-sdk/helm/l2-reth \
  --version 0.1.4 -n default -f values/l2-reth-rpc-public-production.yaml
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  -n default get certificates
ssh ec2-dev 'curl -fsS --max-time 10 https://tso.devnet.doge.xyz/health'
curl -fsS --max-time 15 https://rpc.devnet.doge.xyz \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

Verified TSO revision 2 and public RPC revision 3. Certificates
`tso-service-tls`, `l2-reth-rpc-public-tls` and
`l2-reth-rpc-public-websocket-tls` are Ready. EC2 verified TSO HTTPS returned 200;
public HTTPS RPC returned `0x35fc2` (221122). No DNS, ClusterIssuer or unrelated
running service was changed by this TLS rollout. A separate verified-TLS
WebSocket connection to `wss://ws.rpc.devnet.doge.xyz` subscribed to `newHeads`
and received block `0x407`; this checks more than certificate readiness.

The command also updates other existing local values, including legacy files.
That is configuration generation only: do not install retired services or
Blockscout just because the command lists them as updated. Only the two releases
above were applied for TLS at this checkpoint.

Separately, `make install-fee-oracle` (revision 2) and
`make install-l1-interface` (revision 3) reconciled their previously generated
PublicNode Sepolia RPC settings. Both replacement Pods reached Ready with zero
restarts. L1 retained `l1-interface-data-devnet-20260909` and the same canonical
genesis. Live ConfigMaps now agree with the configured DA RPC. This is a normal
same-instance upgrade, not a cold reset.

## Signer handoff prerequisites still unresolved

Read-only checks on EC2 found three healthy old-instance attestation signers
on ports 4040–4042 and one old Worker. Their existing directories and named
SQLite volumes have not been modified. New policy bundle callbacks now have a
working TLS destination, but replacing old service ownership requires operator
confirmation. Preserve old data; do not reuse old protocol-bound SQLite state
for the new Bridge. Signer public keys must continue to match genesis.

CubeSigner production values select `production_verifier_key_policy` but lack
reviewed verifier/program identity digests and proof-resolver authority, along
with the completed policy evidence fields. Obtain the actual policy deployment
manifest/evidence from its owner. A live-evidence report path/digest is optional
in the service schema; the verifier/program/policy bindings are not optional.
Do not invent digests, treat a health response as proof verification, replace
ECDSA with shadowfork sentinels, or downgrade to transport-only to pass readiness.

Active proof topology and end-to-end withdrawals remain unverified. These
dependencies do not invalidate the separately verified DA, fee-oracle, WP
ingestion and idle-PC startup results.
