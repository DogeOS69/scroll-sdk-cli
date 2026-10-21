# Service AWS permissions during staged preparation

New AWS `setup plan` workflows default to `preparation.awsAccess.mode: managed`.
The pinned SDK must include the `aws-access` chart (0.1.0) and Makefile target.
Plans saved by older CLI versions retain their original workflow. For resources
whose permissions remain operator-managed, explicitly select `mode: external`.
This does not change existing `proofAws.action: reuse` into a write operation.

## Operator inputs and lifecycle

Use the normal AWS credential chain on the operator host, for example an SSO
profile selected by `AWS_PROFILE`. No access keys belong in the spec. `setup aws`
uses the AWS CLI with that identity; it creates workload IAM identities, not
operator credentials. Select the same account/profile for identity provisioning,
resource preparation and uploads. The optional per-step `awsProfile` settings are
for operators who deliberately manage separate sessions.

The operator supplies the account, EKS cluster, namespace, bucket names/regions
and prefixes, signing backends, public-read choices and existing worker networks.
CLI-generated roles are not inputs that operators need to discover and copy.
For a managed AWS plan, the relevant fragment is:

```yaml
preparation:
  awsAccess:
    mode: managed
    # Optional, only when snapshots.s3 is configured:
    snapshot:
      action: create
      publicRead: true
      serviceAccount: snapshot-writer
  proofAws:
    action: create
    publicReadMode: direct-s3
  archive:
    action: create
    publicRead: true
  secretUpload:
    provider: aws
```

This is a fragment, not a complete deployment spec. `proofAws.action: create`
creates missing resources and reconciles the selected resources' permissions;
it can use an existing bucket. `archive.action` and `awsAccess.snapshot.action`
accept `configure` for an existing bucket. Creating resources and managing their
policies are distinct from uploading artifacts. Public access is an explicit
choice; `false` requires a usable S3 Gateway endpoint read path. The CLI reuses
the endpoint recorded by proof preparation when it is in the bucket's region.
Cross-region private read paths must be arranged separately.

1. `setup plan` freezes the intent and writes the public permission inventory to
   `.scrollsdk/aws-service-access.json`. It lists reader identities, exact Secret
   names, and runtime S3/KMS/dstack permission intent. It does not contact AWS for
   this inventory or copy cloud credentials.
2. After `setup genesis`, `setup aws` provisions declared identities/buckets,
   reconciles bucket policies and creates reader roles. It creates empty Secrets
   Manager containers to obtain exact ARNs, then grants each reader only its
   selected ARNs. Outputs are stored in `.data/aws-service-access.json`.
3. `setup render` binds runtime identities and each ExternalSecret's reader,
   and emits `values/aws-access-production.yaml`. Standalone `prep-charts`
   preserves the bindings too. No serialized-JSON fingerprints are introduced.
4. `setup upload-secrets` / `setup push-secrets` fills the containers and preserves
   prepared reader identities. A different upload prefix or region is rejected
   before upload. Debug output never prints an AWS secret-string command.
5. With the External Secrets Operator already installed, the generated Makefile
   installs the `aws-access` identity chart before the service releases that need
   it. For a local SDK checkout before chart publication, set
   `AWS_ACCESS_CHART=/path/to/scroll-sdk/charts/aws-access`.

`setup aws` does not install Helm releases or launch GPU workers. The operator's
AWS identity needs the relevant IAM, KMS, S3, Secrets Manager and metadata
permissions to perform the selected preparation; runtime roles do not receive
those provisioning privileges.

## Permission boundaries

| Identity | Allowed access | Excluded access |
|---|---|---|
| Proof coordinator runtime | Proof prefix Get/Put/Delete; prefix-restricted ListBucket | Other bucket prefixes; Secrets Manager |
| Withdrawal processor runtime | Proof prefix Get/Put; its Bridge KMS key when selected | S3 list/delete; worker-master Secret |
| DA runtime | DA prefix Get/Put; the two segmentation-sidecar prefixes in the proof store; its signing key when KMS is selected | Other proof objects, list/delete, unrelated signing keys |
| Fee oracle / each sequencer runtime | GetPublicKey/Sign on its prepared key when KMS is selected | Other service signing keys |
| Each service's Secret reader | GetSecretValue/DescribeSecret on exact Secret ARNs | Secret writes/deletes/listing; runtime KMS signing, S3 and EC2 |
| Snapshot writer | PutObject and multipart abort/list-parts on the selected prefix | Bucket-wide list, object delete, other prefixes |
| dstack controller | EC2 operations for workers in selected regions/subnets, with project-tag conditions where supported | Other projects' instance termination; general PassRole; load balancer administration |

DA's role is created even with local signing. With KMS signing, its existing
runtime role receives the named S3 policy instead of creating a second runtime
identity. A separate snapshot identity is created for an operator-provided
Kubernetes upload Job; the Job must set `serviceAccountName`. The CLI does not
create snapshot contents, Jobs or a general host/deploy role.

Secret readers use names such as `aws-reader-withdrawal-processor`. Runtime Pods
continue using their runtime ServiceAccounts; ESO uses the reader through
`SecretStore.spec.provider.aws.auth.jwt.serviceAccountRef`. Services without
runtime AWS API calls need no empty runtime IAM role. Capacity-manager consumes
the coordinator's Kubernetes token Secret and dstack API credentials; it does
not inherit the controller's EC2 role.

For Secrets encrypted with a customer-managed key, specify the exact
`awsAccess.secretsKmsKeyArn`. Reader Decrypt grants are constrained to Secrets
Manager and the selected Secret ARNs in the encryption context. The key policy
must permit these IAM grants; this workflow does not take over an existing key
policy. Managed artifact buckets currently require SSE-S3; SSE-KMS artifact
stores use external permission management.

Bucket reconciliation retains other policy statements and manages the existing
CLI statement names, TLS-only access and versioning. It does not grant anonymous
list/write/delete. New reader and standalone runtime roles require matching
ownership tags when resumed; unrelated roles and extra policies are rejected.
There is no automated role/Secret deletion or IAM policy takeover.

## Proof-token migration and existing deployments

The legacy proof Secret contains both `proof-work-token` and
`prover-worker-master`. IAM cannot isolate JSON properties within one Secret.
Managed preparation copies them into two separate Secrets under the deployment
prefix. It preserves both values, checks an existing target rather than rotating
it, and leaves the combined source intact. The coordinator's reader can read
both objects; the withdrawal processor's reader can read only the work token.
The resulting Kubernetes Secret keys/names remain compatible with the services.

Migration is a reviewed deployment change: generate a new managed plan with the
same explicit existing bucket/prefix and legacy `proofAws.secretName`; use
`configure` for the DA/snapshot buckets. Preserve existing local service keys,
KMS key IDs, genesis, database and signer state through their normal import/reuse
inputs. **Do not run a new genesis workflow against an existing chain to migrate
IAM.** For an already-running deployment, prepare in an isolated directory and
review/copy only the permission outputs and final values; install the identity
chart, upload required Secrets, then upgrade the affected releases. Old saved
plans themselves are not rewritten or silently upgraded.

After confirming successful Secret synchronization and runtime access, the
operator can retire the old shared ESO role and combined proof Secret if no
consumers remain. Keeping the old shared role preserves its old permissions;
creating new narrow roles alone cannot revoke them. Do not remove them before
cutover. Existing IAM policies, permission boundaries, SCPs, bucket/endpoint/key
policies and node IMDS access can affect effective access.

## Prerequisites and acceptance

EKS, its IAM OIDC provider, ESO with v1 CRDs and permission to request tokens for
reader ServiceAccounts, node IMDS restrictions, EBS CSI, VPC routing, optional
worker instance profiles, quotas, ACM/DNS and shared databases remain operator
infrastructure. NLB and ALB preparation stays manual. See
[AWS resource coverage](aws-resource-preparation.md) and
[dstack preparation](dstack-aws-preparation.md).

Offline tests cover generated IAM boundaries, no token rotation on retry,
container creation, local-signing DA access, snapshot creation, binding and Helm
rendering. They do not prove effective permissions in an AWS account. Before a
production rollout, verify each Pod's AWS identity and representative allowed
and denied operations, ESO synchronization, actual S3 reads/writes and a bounded
dstack launch/terminate canary. No live deployment is performed by these tests.

References: [AWS IRSA](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html),
[ESO AWS authentication](https://external-secrets.io/latest/provider/aws-secrets-manager/),
[EC2 action/resource support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html).
