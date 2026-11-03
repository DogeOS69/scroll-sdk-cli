# Import external AWS references into a deployment spec

Run `scrollsdk setup import-aws` after creating infrastructure and before
`setup plan`. It reads explicitly selected CloudFormation outputs and fills the
operator's spec. It never creates resources, changes policies, reads Secret
contents, installs Helm releases or changes a saved preparation plan.

Keep the deployment spec and import manifest in a private operator directory.
Copy `infrastructure/aws/cloudformation/parameters/spec-import.example.yaml` from the CLI
checkout. Replace its stack names and remove sources you do not use. Match
`endpoint`, `binding` and bootnode `index` to the intent already in your spec.
Fill `infrastructure.aws.accountId` and `region` first. Application topology,
Service names/ports, enabled public bootnodes, buckets/prefixes and cluster
selection remain operator inputs; they are not inferred from resource names.

```sh
# Preview changed field names. This performs only DescribeStacks calls.
scrollsdk setup import-aws --manifest infrastructure/spec-import.yaml \
  --spec deployment-spec.yaml --profile your-profile

# Write references after reviewing the preview.
scrollsdk setup import-aws --manifest infrastructure/spec-import.yaml \
  --spec deployment-spec.yaml --profile your-profile --write

# Only when intentionally replacing existing, different references:
scrollsdk setup import-aws --manifest infrastructure/spec-import.yaml \
  --spec deployment-spec.yaml --profile your-profile --write --replace

scrollsdk setup plan
scrollsdk setup aws
scrollsdk setup genesis
```

The source manifest is separate from DeploymentSpec; do not add it to the spec.
One source identifies one stack's role, replacing several manual ARN copies:

```yaml
version: 1
sources:
  - kind: signing-key
    stack: example-key-sequencer-0
    identity: sequencer
    index: 0
  - kind: workload-access
    stack: example-application-roles
  - kind: alb
    stack: example-public-alb
    endpoint: public
  - kind: bootnode-nlb
    stack: example-bootnode-0
    index: 0
  - kind: http-target
    stack: example-portal-target
    binding: frontends
```

Alternatively, replace `stack` with `file: outputs/example.outputs.json` for an
offline import. File paths are relative to the manifest. Supported JSON formats
are the `Stacks[0].Outputs` array, `{ "Outputs": [...] }`, or a full
`describe-stacks` response containing exactly one stack. Recorded output files
are snapshots: refresh them when infrastructure changes. Online imports require
the AWS CLI and use its credential chain, optional `--profile`, and the spec's
region. Each named stack is read once; there is no account-wide discovery.

## Supported mappings

| Source kind | Selection | Fields imported |
| --- | --- | --- |
| `signing-identities` | Stack with the five `*KeyArn` outputs, such as an adopted stack | Five key ARNs, regions, reuse/KMS mode; sequencers matched by `index` |
| `signing-key` | `identity`: `ethDaSubmitter`, `feeOracle`, `sequencer` (+ `index`), or `bridge` | One key ARN and reuse/KMS configuration |
| `workload-access` | `application-roles.yaml` or a stack with the same outputs | Six application role ARNs; Pod Identity mode when all six association outputs exist, otherwise IRSA |
| `capacity-access` | dstack role stack | `infrastructure.aws.roles.dstackController` |
| `secrets-reader` | Dedicated reader role stack | `infrastructure.aws.roles.externalSecrets`; does not bind or modify shared ESO |
| `alb` | Existing spec `endpoint` | ALB/listener references |
| `http-target` | Existing spec `binding` | Target group ARN; preserves endpoint and Service reference |
| `bootnode-nlb` | Explicitly enabled bootnode `index` | Existing mode, target group ARN and security group |
| `capacity-alb`, `capacity-target` | Internal dstack ALB and controller target stacks | Existing ALB connection, listener, target group and `PrivateUrl` |
| `secret-metadata` | Proof token metadata stack | `preparation.proofAws.secretName` only |

`alb`, `http-target`, `bootnode-nlb`, `capacity-alb` and `capacity-target` accept an
optional `prefix` for stacks that hold several resources of the same kind. The
importer then reads `<prefix><Output>` instead of `<Output>`, for example one ALB
stack with several target groups, or one stack with two bootnode NLBs:

```yaml
- kind: http-target
  stack: example-public-edge
  binding: frontends
  prefix: Portal            # reads PortalTargetGroupArn
- kind: bootnode-nlb
  stack: example-p2p-network
  index: 0
  prefix: Bootnode0         # reads Bootnode0TargetGroupArn and Bootnode0SecurityGroupId
```

A prefix starts with an uppercase letter and contains only letters and digits.

An internal ALB stack without the `PrivateUrl` output (for example an adopted
one) requires the certificate hostname in `capacityManager.connection.serverUrl`. Never use an ALB-generated DNS name as a substitute
for the certificate hostname. The importer does not guess namespaces, public
DNS names, workload permissions, bucket delivery modes or Secret contents.

## Preservation and failure behavior

- Preview reports only changed field paths and whether an existing value would
  be replaced. It never prints the full spec, environment references or values.
- Untouched spec values and literal `$ENV:...` references remain unchanged.
  Import does not resolve environment variables or require deployment secrets.
- Missing fields and recognizable `REPLACE...`, `<...>` or `TODO` placeholders
  can be filled with `--write`. Different existing values, including aliases
  replaced by full key ARNs, require the explicit `--replace` flag.
- A write creates a private `deployment-spec.yaml.<id>.bak` containing the exact
  original bytes, then atomically replaces the spec with mode 0600. YAML is
  reserialized: comments and formatting are retained in the backup, not the new
  file. Keep backups outside public Git. An identical repeated import writes
  nothing and creates no additional backup.
- Missing outputs, ambiguous indices, incompatible resource/account/region
  references, conflicting sources or unsuccessful stack status fail before any
  spec write. `--replace` cannot bypass those errors. Import is reference/format
  validation, not IAM simulation or network compliance auditing.
- Frozen `.scrollsdk` inputs and symlink destinations are rejected. If the source
  spec changes after planning, this command does not update the saved plan or
  deployed application. Create a new plan when that is the intended operation.
