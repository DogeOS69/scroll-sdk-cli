# AWS infrastructure and application configuration

AWS infrastructure is prepared before genesis using the external
[CloudFormation template pack](../infrastructure/aws/cloudformation/README.md),
or an existing infrastructure owner's tooling. The application CLI discovers
resource information and writes production values. It does not create resources,
modify permissions, simulate policies or audit AWS network/bucket configuration
in the spec preparation workflow.

| Infrastructure | External owner prepares | CLI consumes and projects |
| --- | --- | --- |
| Five signing KMS keys for two sequencers | Keys, aliases, key policies | Canonical ARN, region, public key and derived signer address |
| Six application roles | Trust, KMS/S3 policies and Pod Identity associations | Named ServiceAccounts; optional IRSA annotations for legacy deployments |
| dstack role | Pod Identity association, EC2 policy, optional instance-profile access | Controller ServiceAccount name and default credential chain |
| Existing archive/proof/snapshot buckets | Buckets, complete access policies, encryption and retention | Region, bucket, prefix and artifact URLs |
| Proof Secret | Secret metadata and two random credentials | Secret name/region and ExternalSecret references; never credential contents |
| ALBs and target groups | Listeners, routes, TLS/DNS, SG/backend access | TargetGroupBindings and TSO subnet peers |
| Optional bootnode NLB | NLB, fixed EIPs, target groups and partner allowlist | Binding, SG IDs and exported public endpoints |
| External Secrets reader | Prefix-scoped role and separately installed ServiceAccount | Existing reader/SecretStore references |
| EKS, OIDC, VPC, NAT, ACM, RDS | Existing platform infrastructure | Existing cluster, network, database and certificate references |

The CLI retains local schema/required-input validation, clear resource-read
errors and pinned identity preservation. `setup aws` is repeatable discovery;
`setup render` projects its outputs into `*-production.yaml`. Credentials and
application artifacts are uploaded only by their explicit later workflow steps.
Those uploads do not grant bucket public access or change IAM policies.

Use stable infrastructure names. Test resources should use an explicit
`nonproduction-deletable` classification, descriptive aliases and corresponding
tags. Deletable labels do not bypass CloudFormation Retain or LB deletion
protection: teardown remains an explicit infrastructure operation.

## EKS Pod Identity

New AWS deployments select `infrastructure.aws.workloadIdentity: pod-identity`.
Prepare the cluster Agent and workload roles/associations using the external
[CloudFormation lifecycle templates](../infrastructure/aws/cloudformation/README.md).
`setup aws` reads the selected role and association metadata. Rendering pins the
ServiceAccount name and removes its IRSA role annotation; it does not write IAM
policies or create an association. Proof consumers use ambient SDK credentials.
Shared ESO retains its separate IRSA reader. An omitted field keeps legacy IRSA
behavior; migrating existing Pods requires the normal Helm rollout after render.
