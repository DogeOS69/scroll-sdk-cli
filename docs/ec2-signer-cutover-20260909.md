# EC2 attestation signer cutover — verified 2026-09-09

The user explicitly authorized replacing the old services on `ec2-dev`.
This procedure retains their data and the existing KMS identities. It does not
change the Bridge/genesis or claim full withdrawal/proof acceptance.

## Final deployment

- Host root: `/home/ubuntu/dogeos-devnet-20260909-signers` (0700).
- Per-signer directories: `signer0`, `signer1`, `signer2`.
- Compose projects: `dogeos-devnet-20260909-signer0` through `signer2`.
- Image: `dogeos69/attestation-signer:v0.3.0-beta.3e`, pinned digest
  `sha256:6f3e24434948888b8833251367dd1556246d75d5a57d7bf1cc9dbd1cd2560765`.
- Runtime build commit: `e3fed3e9f246db191dd5073bb7c87932b4c9f2eb`.
- Private listener addresses: `192.168.30.65:4040`, `:4041`, `:4042`.
- Fresh named volumes: `dogeos-devnet-20260909-signerN_signer-data`.
- Protocol context SHA-256:
  `c24bff010e525e4992eee41511bdd5cbd2f84313fd0cd3952881a1ced0ff73e7`.
- Callbacks: `https://tso.devnet.doge.xyz`; mode: testnet/observe.

All three final containers are healthy with zero restarts. Runtime KMS public
keys match the three genesis descriptors. Cluster-side `/ready` requests returned
200, and TSO re-registration queried each actual signer health endpoint and
registered it as Attestation/ECDSA.

## Ordered procedure and manual changes

Run local steps from the deployment project. The checked-in concrete templates
are `ops/attestation-devnet-compose.yaml` and
`ops/attestation-devnet-partner.toml`. Their inputs are the CLI-exported
`.data/signer-policy-bundle`, not a newly generated signer identity.

1. Inspect the old containers' mounts, image identities and endpoints. Compare
   descriptor public keys against genesis; do not run signer init to generate
   replacement keys. Pull the pinned beta.3e image before the cutover.
2. Create the new root and three per-signer directories with restricted
   permissions. Refuse to silently overwrite an existing deployment root on a
   first install; for a retry, inspect and reuse only the verified new root.
3. **On EC2 only**, copy each old
   `/home/ubuntu/attestation-signerN/docker-compose/attestation-signer.env` to its
   new directory as `identity.env`, chmod 0600. This preserves the existing KMS
   backend, key, region and expected signer identity. Never print or copy private
   credentials into Git. Copy the exported `signer-policy.env` after identity.env
   in Compose's env_file list so the new context/mode/callback settings win.
4. Install the checked-in Compose file as `compose.yaml`, the partner template
   as `partner.toml`, and the exported context at `policy/protocol_context.json`.
   Verify all three file hashes equal the canonical hash above. There is **no**
   `ATTESTATION_SIGNER_UPGRADE_GENESIS_SNAPSHOT_BUNDLE_JSON` in this fresh profile;
   do not carry over the old upgrade snapshot or old SQLite volume.
5. The partner TOML changes the artifact allowlist from the old west-2 archive
   origin to `https://dogeos-dev0829-proof-artifacts.s3.us-east-1.amazonaws.com`.
   Existing testnet single-source terminal trust configuration is retained;
   production source quorums, proof identities and rotation targets are not
   fabricated. Metrics listen inside the container on 9100 but are not published
   on the host; signing ports are bound only to the EC2 private IP.
6. Validate each Compose project before stopping anything:

   ```bash
   # On ec2-dev; repeat N=0,1,2.
   N=0
   SIGNER_PORT=$((4040+N)) docker compose \
     --project-directory "/home/ubuntu/dogeos-devnet-20260909-signers/signer$N" \
     -p "dogeos-devnet-20260909-signer$N" config --quiet
   ```

7. Back up old configuration before stopping services. The old Worker token is
   root-owned, so plain tar failed and the first incomplete archive was retained
   as `old-service-directories.partial.tar.gz`. Retry the complete backup using
   existing sudo rights; no token content is displayed:

   ```bash
   # On ec2-dev, after creating the restricted backups directory.
   sudo -n tar -czf \
     /home/ubuntu/dogeos-devnet-20260909-signers/backups/old-service-directories.tar.gz \
     -C /home/ubuntu attestation-signer0 attestation-signer1 attestation-signer2 prover-worker-mock
   docker stop --timeout 30 \
     attestation-signer0-attestation-signer-1 \
     attestation-signer1-attestation-signer-1 \
     attestation-signer2-attestation-signer-1 \
     dogeos-proof-topology-worker-prover-worker-1
   ```

   The executed stop used the equivalent `--time 30` spelling, which Docker
   warns is deprecated. The failed initial backup stopped before any service
   stop. After successful backup and stop, mount each old signer volume
   read-only with `busybox:1.36.1` and archive **all** files, including SQLite WAL
   sidecars, into `signerN-sqlite-volume.tar.gz`. The Worker's readiness volume
   was also archived; its read-only material mounts remain intact. Protect
   backup files with mode 0600. Old containers, directories and volumes remain
   present, stopped rather than removed. Backups are private on EC2 only.
8. Start each new project using the same project directory/name and SIGNER_PORT
   as step 6, replacing `config --quiet` with `up -d`. Verify the new named volume
   was created, not an old volume attached. Do not start a new Worker while proof
   topology is disabled; the old Worker remains stopped with its data retained.

## Shadowfork RPC compatibility discovered during startup

The initial direct Shadowfork RPC override failed before serving:
`terminal_anchor_sources.sources.rpc_url must not include a query string`.
This is source-URL validation, not a KMS failure. The final template instead
uses the existing private proxy `http://192.168.30.65:22555/`. Its upstream was
read-only verified to target Shadowfork `d494aabf-4335-46e1-ac48-e90b3ebd4850`.
The proxy injects the query API key upstream and has an existing compatibility
rewrite of RPC `"chain":"shadowfork"` to `"chain":"test"`. That rewrite is
specific to this Shadowfork setup, not production network evidence. The proxy
was not changed or restarted. The corrected Compose files recreated the three
new containers; their final restart counts are zero.

## Runtime checks and registration

```bash
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  -n default exec l2-reth-rpc-0 -- sh -c \
  'for p in 4040 4041 4042; do curl -fsS --max-time 10 http://192.168.30.65:$p/ready; done'
kubectl --context arn:aws:eks:us-east-1:074120976575:cluster/dogeos-devnet-cluster \
  -n default exec l2-reth-rpc-0 -- \
  curl -fsS --max-time 30 -X POST http://withdrawal-processor:3000/register-tso
```

The registration endpoint returned `{"status":"ok"}` / HTTP 200. TSO logs
confirmed all three actual public keys, roles and ECDSA mode, followed by the
new Bridge script `a914dc63eedf53e1b03df869669c249fbe866c0d700e87`.
This registers configuration; it is not a signed transaction or a settlement.
In particular, CubeSigner uses a public-key override during registration, so
registration success does not establish its missing service/policy readiness.

CLI `signer preflight` from the WSL machine could not reach the private address.
A diagnostic SSH loopback tunnel was then rejected by preflight's intentional
routable-endpoint validation. Neither attempt passed; the tunnel was closed and
no descriptors were overwritten. Run that CLI command from a machine with VPN
access to the real signer endpoint. For this rollout, direct EC2 health checks,
canonical context hashes and actual cluster-side TSO health queries established
the runtime identities/reachability independently.

`production_v2_ready=false` is accurately reported under this observe profile.
AdvanceL1 reports its configured checked policy; AdvanceL2 and rotations lack
complete production policy. Do not claim production enforce acceptance.

## Rollback boundary and remaining blocker

Old volumes and directory archives permit recovery of the old services, but
never restart old and new signers on the same ports together. Stop new projects
first, verify old TSO/instance ownership, then explicitly authorize rollback.
Do not point an old signer DB at the new protocol context.

EC2 cutover is complete. Full bridge/withdrawal acceptance is still blocked by
the CubeSigner production policy information described in
[the TLS/handoff guide](devnet-tls-and-signer-handoff.md). No policy was downgraded,
and no artificial signing request was submitted to claim end-to-end success.
