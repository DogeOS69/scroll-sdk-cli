# External AWS infrastructure for dstack

Prepare the controller role, IRSA trust, EC2 permissions and networking with the
[CloudFormation templates](../infrastructure/aws/cloudformation/README.md).
The CLI consumes resource references; it does not audit or reconcile them.

Set `infrastructure.aws.roles.dstackController`, enable `dstackController`, and
select `preparation.dstack.mode: import`, `providers: [aws]` and `aws.vpcIds`.
The controller ServiceAccount defaults to `dstack-controller` in the deployment
namespace. Its name must match the infrastructure role trust. Optional
`awsProfile` selects the operator's read credentials; they are never copied to a
workload. The controller obtains AWS credentials through IRSA.

`setup aws` reads the role ARN and writes it to local configuration. Render adds
it to `dstack-controller-production.yaml` ServiceAccount annotations. There is no
IAM simulation, policy inspection, subnet eligibility audit, instance-profile
trust check or role takeover. Repeating discovery refreshes metadata without
creating resources. Spec syntax, missing inputs and failed provider reads still
produce errors.

For dstack's external private HTTPS edge, set `capacityManager.connection` to
`mode: existing-alb`, the `serverUrl`, and `existingAlb` containing
`loadBalancerArn`, `listenerArn`, `targetGroupArn`. The CLI reads the ALB security
group IDs and target group port/type and generates the Helm TargetGroupBinding.
The infrastructure owner prepares TLS, DNS, forwarding, SG rules and worker
routing. `existing-https` remains available for another independently managed
endpoint. `internal-alb` is retired.

The worker VPC/subnets, NAT routes, instance profile and optional PassRole grant
remain external infrastructure. `dstack-role.yaml` supports two required subnets
and an optional third. Include every subnet that the selected backend can use.
A role template creates no GPU instance. Fleet limits, GPU types and budget are
Capacity Manager intent; actual worker creation is a runtime operation.

Credential import and optional dstack database initialization occur in
`proof-materials`. They do not run during resource discovery. Before activation,
verify IRSA, API access and endpoint connectivity using infrastructure/operator
tools. An ARN in production YAML does not prove runtime readiness.
