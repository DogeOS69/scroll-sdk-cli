# Prepare AWS access for dstack workers

The staged workflow can create the dstack controller IAM role and its IRSA trust,
or discover an existing role. The controller uses the AWS SDK default credential
chain with the ServiceAccount's projected web identity token. The operator's AWS
CLI profile is used only during preparation; access keys are never copied to the
controller or the deployment spec.

This prepares access for EC2 worker fleets using the chart's pinned dstack 0.21.5.
It does not allocate GPU instances during preparation. Existing VPCs, subnet routes,
EKS/OIDC, optional worker instance profiles and GPU quotas remain operator-owned.
NLBs and ALBs remain manually prepared; this feature does not create or modify them.

## Operator inputs and workflow

Merge this fragment into a complete deployment spec. All identifiers below are
nonfunctional examples; replace them in your private deployment directory.

```yaml
infrastructure:
  provider: aws
  namespace: example
  aws:
    accountId: '000000000000'
    region: us-east-1
    eksClusterName: EXAMPLE_CLUSTER

dstackController:
  enabled: true
  serviceAccount:
    name: dstack-controller

preparation:
  dstack:
    mode: import
    providers: [aws]
    aws:
      action: create
      awsProfile: EXAMPLE_OPERATOR_PROFILE
      # Optional; defaults to a name derived from deployment name and EKS cluster.
      controllerRoleName: EXAMPLE_DSTACK_CONTROLLER
      vpcIds:
        us-east-1: vpc-00000000000000000
      publicIps: false
      # Optional existing EC2 instance profile, not the controller IRSA role.
      # iamInstanceProfile: EXAMPLE_WORKER_PROFILE
```

Each `capacityManager.regions` entry needs a `vpcIds` entry. Configure any existing
dstack database as described in [spec preparation](spec-preparation.md). Then use
the normal staged workflow from the private input directory:

```bash
scrollsdk setup plan --spec deployment-spec.yaml --sdk-dir /path/to/scroll-sdk --output ./deployment
scrollsdk setup genesis --dir ./deployment
scrollsdk setup aws --dir ./deployment
```

Review the plan before running `setup aws`: that stage also executes any other
AWS preparation selected in the spec. Its new `dstack-aws` step runs before
`dstack-config`. The step queries the caller account, EKS issuer, registered OIDC
provider, each VPC's subnets/routes and optional instance profile, then prepares
the role. Generated `.data/dstack-aws.json` contains public resource metadata and
the intended worker policy; it is a local deployment record, not a source fixture.

The CLI writes the role ARN, explicit ServiceAccount name and
`defaultCredentialsEnabled: true` into `.data/doge-config.toml`. Later rendering
and capacity-manager preparation consume those outputs automatically. Do not copy
the ARN back into the spec. The generated chart uses IRSA and disables EC2 node
metadata fallback. No credentials or preparation-only fields are passed in the
native dstack AWS backend configuration.

Continue the normal proof/preparation stages, upload Secrets and install with the
generated Makefile. IAM creation alone does not start or restart a controller.
Completed workflow steps are skipped on resume; rerunning `setup aws` resumes
failed/pending steps, rather than continuously reconciling a finished deployment.
Back up the local deployment directory. Missing records from completed steps must
be restored from that backup; do not delete workflow state to trigger a repair.

## Create versus reuse

- `action: create` creates the named role if absent and writes the inline policy
  `scrollsdk-dstack-workers`. A retry updates this policy and the trust only when
  the role has matching `ManagedBy`, `Deployment`, `Cluster`, `Namespace` and
  `ServiceAccount` tags. It refuses to take over an unrelated existing role.
  Other attached policies are not removed. Review those separately if an operator
  has attached additional grants to a CLI-created role.
- `action: reuse` only reads AWS metadata. Supply `controllerRoleName`, an existing
  `eks.amazonaws.com/role-arn` annotation, or use the default derived role name.
  The role must trust the exact EKS provider and namespace/ServiceAccount, with
  the STS audience. The CLI does not repair policies in reuse mode. The operator
  must compare its grants with `dstackWorkerPolicy` in
  [the implementation](../src/utils/preparation-dstack-aws.ts) and perform a runtime
  canary; a matching trust statement is not proof of effective permissions.
- Omit `action` to retain the previous manual workflow: supply
  `defaultCredentialsEnabled: true` and the existing role annotation yourself.
  Use this route for a ServiceAccount managed outside the chart. New preparation
  requires a chart-managed account so the generated annotation actually takes effect.

Trust documents are interpreted as JSON fields. Formatting, key ordering and a
trailing newline do not affect acceptance. There is no new file fingerprint.

## Permissions and prerequisites

The operator needs an authenticated AWS CLI profile. For both actions it needs:

- `sts:GetCallerIdentity`, `eks:DescribeCluster` for the selected cluster;
- `iam:GetOpenIDConnectProvider`, `iam:GetRole`, and `iam:GetInstanceProfile` when
  that option is selected;
- `ec2:DescribeVpcs`, `ec2:DescribeSubnets`, `ec2:DescribeRouteTables` in each selected region.

Create additionally needs `iam:CreateRole`, `iam:TagRole`,
`iam:UpdateAssumeRolePolicy` and `iam:PutRolePolicy` for the selected controller
role. These are operator permissions, not grants to the controller. IAM resources
can be scoped to their exact ARNs; EC2 describe operations use `Resource: "*"`.
Other selected AWS preparation steps have their own operator requirements.

The generated controller policy uses named EC2 fleet operations (instance launch
and termination, security groups, tags, volumes, placement groups and EIPs) plus
quota reads. It restricts calls to `vpcIds` regions. **Its EC2 resource scope is
regional, not limited by VPC or deployment tag.** Use a dedicated account/region
or `reuse` with a separately reviewed policy if stronger resource isolation is
required. There are no IAM administration, S3, KMS or load-balancer grants.
This is a worker-fleet policy, not permission to operate dstack gateways or all
future dstack features. Reassess it when changing the controller version.

When `iamInstanceProfile` is provided, the CLI checks that the profile exists in
the selected account and contains an EC2-trusted role. It adds only
`iam:GetInstanceProfile` on that profile and `iam:PassRole` on its contained role,
conditioned on `ec2.amazonaws.com`. Create the profile manually if needed:

1. Create a separate IAM role whose trust allows `ec2.amazonaws.com` to perform
   `sts:AssumeRole`.
2. Attach only the worker's required application policy. Ordinary workers reading
   public proof artifacts do not need the controller's EC2 administration grants.
3. Create an IAM instance profile and add that role; put the profile **name** in
   `iamInstanceProfile`. Wait for IAM propagation before launching a canary.

For IRSA, the cluster's IAM OIDC provider must already exist and include
`sts.amazonaws.com` in its client IDs. If absent, the cluster administrator can
associate it once, after selecting the correct profile/cluster/region:

```bash
eksctl utils associate-iam-oidc-provider \
  --cluster EXAMPLE_CLUSTER --region us-east-1 \
  --profile EXAMPLE_OPERATOR_PROFILE --approve
```

See AWS's [IRSA setup procedure](https://docs.aws.amazon.com/eks/latest/userguide/associate-service-account-role.html)
for manual role creation and verification. The CLI constructs the trust with
`StringEquals` on both the issuer's `aud` and exact `sub`, rather than a wildcard
namespace. An allow statement does not override SCPs, permission boundaries,
explicit denies or other organization controls.

## Existing network preparation

For each VPC, prepare available subnets and route tables compatible with the
pinned dstack selector. An explicit subnet association takes precedence over the
VPC's main route table:

- `publicIps: true`: an Internet Gateway route.
- `publicIps: false` (default): an IPv4 default route through a NAT gateway,
  transit gateway or VPC peering connection. Blackhole routes are rejected.
  A TGW/peering route is only a candidate: the remote network still needs working
  internet egress and return routes.

The CLI records candidate subnet IDs, not a connectivity certificate. It does
not create VPCs, subnets, routes, NAT gateways, peering, load balancers or DNS.
The operator must verify:

1. Controller-to-worker private IP/SSH access and return traffic; review security
   groups and NACLs. Cross-region VPCs require explicit routing and DNS design.
2. Worker egress to image registries, package downloads, proof artifacts and the
   configured proof-work endpoint. Private EKS pods also need access to AWS STS
   and the APIs they use, through egress or suitable VPC endpoints.
3. Access from the manager to the existing HTTPS controller endpoint. Prepare
   its ALB/NLB/proxy, certificate and DNS manually.
4. On-demand GPU vCPU quotas, instance-type availability, subnet address capacity,
   EBS capacity, and EIP quota if the selected instance type uses EIPs. For Spot
   extensions, ensure the EC2 Spot service-linked role and Spot quota exist;
   this command does not create them.

See [dstack backend documentation](https://dstack.ai/docs/concepts/backends/)
for backend behavior; this CLI implementation targets 0.21.5, so newer upstream
features may require additional permissions.

## Troubleshooting and cleanup

An AWS read failure stops preparation before IAM mutation. An unavailable route
or incorrect workload trust must be repaired by the operator. A create failure
can leave a correctly tagged role without its policy; rerun the pending AWS stage
after repairing operator permissions. There is no automatic rollback of IAM.
AWS stderr is omitted from normal errors; diagnose with the selected profile
privately rather than publishing logs or credential-bearing configuration.

After installation, verify the Pod's ServiceAccount annotation, projected token
and AWS identity, then run a bounded worker canary. Verify launch, artifact access,
job execution and termination. Neither offline tests nor AWS metadata reads prove
that these runtime operations work.

To retire the resources, stop capacity-manager, drain/terminate workers and stop
the controller first. Inspect the saved role and ownership tags, remove only the
`scrollsdk-dstack-workers` inline policy, and delete the dedicated role only after
checking for other attachments/users. Reused roles, optional worker profiles,
network resources and load balancers remain operator-owned; CLI preparation does
not delete any of them.
