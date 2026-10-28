"""Offline regression checks for infrastructure ownership and authorization boundaries."""

import importlib.util
import json
from pathlib import Path
import re
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("validate_parameters", ROOT / "validate_parameters.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


def load(name):
    return yaml.safe_load((ROOT / (name + ".yaml")).read_text())


def example(name):
    return json.loads((ROOT / "parameters" / (name + ".example.json")).read_text())


def filled(name, **overrides):
    """Disposable, non-live values for evaluating templates offline."""
    entries = example(name)
    values = {entry["ParameterKey"]: entry["ParameterValue"] for entry in entries}
    replacements = {
        "sg-REPLACELB": "sg-0123456789abcdef0",
        "sg-REPLACEBACKEND": "sg-0123456789abcdef1",
        "REPLACE_EKS_CLUSTER": "fixture-cluster",
        "REPLACE_EXISTING_ESO_ROLE": "fixture-eso-role",
        "vpc-REPLACE": "vpc-0123456789abcdef0",
        "subnet-REPLACEA": "subnet-0123456789abcdef0",
        "subnet-REPLACEB": "subnet-0123456789abcdef1",
        "eipalloc-REPLACEA": "eipalloc-0123456789abcdef0",
        "eipalloc-REPLACEB": "eipalloc-0123456789abcdef1",
    }
    for key, value in values.items():
        value = replacements.get(value, value)
        value = value.replace("123456789012", "999000111222").replace("00000000-0000-0000-0000", "11111111-1111-1111-1111")
        value = value.replace("REPLACEWITHISSUERID", "A" * 32).replace("replace-existing-", "fixture-")
        value = value.replace("REPLACE_ENV", "fixture").replace("REPLACE_PURPOSE", "eth-da").replace("example.invalid", "fixture.invalid")
        values[key] = value
    values.update({key: str(value) for key, value in overrides.items()})
    return [{"ParameterKey": key, "ParameterValue": value} for key, value in values.items()]


def render(value, params, conditions):
    """Resolve the subset of CFN intrinsics in policy documents, without providers."""
    if isinstance(value, list):
        return [item for entry in value if (item := render(entry, params, conditions)) is not None]
    if not isinstance(value, dict):
        return value
    if set(value) == {"Ref"}:
        return params[value["Ref"]]
    if set(value) == {"Fn::If"}:
        condition, yes, no = value["Fn::If"]
        return render(yes if conditions[condition] else no, params, conditions)
    if set(value) == {"Fn::Sub"}:
        return re.sub(r"\$\{([^}]+)\}", lambda match: str(params[match[1]]), value["Fn::Sub"])
    return {key: render(item, params, conditions) for key, item in value.items()}


def resolved(name, params_name=None, **overrides):
    template = load(name)
    params = CHECK.validate(template, filled(params_name or name, **overrides))
    params.update({"AWS::Partition": "aws", "AWS::AccountId": "999000111222", "AWS::Region": "us-east-2", "AWS::URLSuffix": "amazonaws.com", "AWS::NoValue": None})
    conditions = {key: CHECK.evaluate_rule(value, params) for key, value in template.get("Conditions", {}).items()}
    return template, params, conditions


class TemplateContracts(unittest.TestCase):
    def test_stable_environment_and_resource_purpose_tags(self):
        for path in ROOT.glob("*.yaml"):
            template = yaml.safe_load(path.read_text())
            self.assertIn("Environment", template["Parameters"])
            for resource in template["Resources"].values():
                tags = resource.get("Properties", {}).get("Tags")
                if tags:
                    by_key = {tag["Key"]: tag["Value"] for tag in tags}
                    self.assertEqual(by_key["Environment"], {"Ref": "Environment"})
                    self.assertTrue(by_key["Purpose"])

    def test_examples_are_non_deployable_and_parameter_names_match(self):
        for path in sorted((ROOT / "parameters").glob("*.json")):
            name = path.name.split(".")[0]
            entries = json.loads(path.read_text())
            with self.subTest(path=path.name):
                self.assertTrue(all(x["ParameterKey"] in load(name)["Parameters"] for x in entries))
                with self.assertRaises(ValueError):
                    CHECK.validate(load(name), entries)

    def test_all_filled_examples_pass_local_validation(self):
        for path in sorted((ROOT / "parameters").glob("*.json")):
            variant = path.name.removesuffix(".example.json")
            with self.subTest(variant=variant):
                CHECK.validate(load(variant.split(".")[0]), filled(variant))

    def test_reuse_does_not_create_or_retarget_keys(self):
        template, params, conditions = resolved("signing-key", "signing-key.reuse")
        active = [r for r in template["Resources"].values() if conditions[r["Condition"]]]
        self.assertEqual(active, [])
        self.assertEqual(render(template["Outputs"]["KeyArn"]["Value"], params, conditions), params["ExistingKeyArn"])
        with self.assertRaisesRegex(ValueError, "reuse requires"):
            CHECK.validate(template, filled("signing-key.reuse", ExistingKeyArn=""))
        with self.assertRaisesRegex(ValueError, "create requires"):
            CHECK.validate(template, filled("signing-key.reuse", Mode="create"))

    def test_new_key_requires_explicit_mode_and_is_retained(self):
        template, _, conditions = resolved("signing-key", "signing-key.create")
        self.assertTrue(conditions["CreateKey"])
        for item in template["Resources"].values():
            self.assertEqual(item["DeletionPolicy"], "Retain")
            self.assertEqual(item["UpdateReplacePolicy"], "Retain")
        key = template["Resources"]["SigningKey"]["Properties"]
        self.assertEqual((key["KeySpec"], key["KeyUsage"]), ("ECC_SECG_P256K1", "SIGN_VERIFY"))
        self.assertNotIn("EnableKeyRotation", key)

    def test_signing_alias_accepts_operator_namespace_and_rejects_invalid_names(self):
        template = load("signing-key")
        aliases = [
            "alias/testnet/dogeos-testnet-cluster/" + purpose
            for purpose in ("eth-da-submitter", "fee-oracle", "sequencer-0", "sequencer-1", "bridge-sequencer")
        ] + ["alias/dogeos/fixture/ethda", "alias/" + "x" * 250]
        for alias in aliases:
            with self.subTest(alias=alias):
                CHECK.validate(template, filled("signing-key.create", AliasName=alias))
        for alias in ("alias/aws/fee-oracle", "testnet/fee-oracle", "alias/", "alias/fee oracle", "alias/fee:oracle", "alias/" + "x" * 251):
            with self.subTest(alias=alias), self.assertRaisesRegex(ValueError, "Invalid format: AliasName"):
                CHECK.validate(template, filled("signing-key.create", AliasName=alias))

    def test_pod_identity_binds_exact_cluster_namespace_and_service_account(self):
        for name in ('application-roles', 'dstack-role'):
            template, params, conditions = resolved(name)
            self.assertTrue(conditions['UsePodIdentity'])
            roles = {key: item for key, item in template['Resources'].items() if item['Type'] == 'AWS::IAM::Role'}
            for key, item in roles.items():
                statement = render(item['Properties']['AssumeRolePolicyDocument'], params, conditions)['Statement'][0]
                self.assertEqual(statement['Principal'], {'Service': 'pods.eks.amazonaws.com'})
                self.assertEqual(statement['Action'], ['sts:AssumeRole', 'sts:TagSession'])
                tags = statement['Condition']['StringEquals']
                self.assertEqual(tags['aws:RequestTag/eks-cluster-arn'], 'arn:aws:eks:us-east-2:999000111222:cluster/fixture-cluster')
                self.assertEqual(tags['aws:RequestTag/kubernetes-namespace'], params['Namespace'])
                association = template['Resources'][key + 'Association']
                self.assertEqual(association['Condition'], 'UsePodIdentity')
                self.assertFalse(association['Properties']['DisableSessionTags'])
                self.assertEqual(association['Properties']['RoleArn'], {'Fn::GetAtt': [key, 'Arn']})
                self.assertEqual(render(association['Properties']['ServiceAccount'], params, conditions), tags['aws:RequestTag/kubernetes-service-account'])

    def test_irsa_is_exact_service_account_and_audience(self):
        for name in ("application-roles", "dstack-role", "secrets-reader-role"):
            template, params, conditions = resolved(name, **({"WorkloadIdentity": "irsa"} if name != "secrets-reader-role" else {}))
            for item in template["Resources"].values():
                if item["Type"] != "AWS::IAM::Role":
                    continue
                trust = json.loads(render(item["Properties"]["AssumeRolePolicyDocument"], params, conditions))
                stmt = trust["Statement"][0]
                self.assertEqual(stmt["Action"], "sts:AssumeRoleWithWebIdentity")
                equals = stmt["Condition"]["StringEquals"]
                self.assertEqual(equals[params["OidcIssuer"] + ":aud"], "sts.amazonaws.com")
                subject = equals[params["OidcIssuer"] + ":sub"]
                self.assertTrue(subject.startswith("system:serviceaccount:default:"))
                self.assertNotIn("*", subject)

    def test_pod_identity_probe_is_scoped_and_does_not_create_business_resources(self):
        template, params, conditions = resolved("pod-identity-probe")
        resources = template["Resources"]
        self.assertEqual({r["Type"] for r in resources.values()}, {"AWS::IAM::Role", "AWS::EKS::PodIdentityAssociation"})
        role = resources["ProbeRole"]["Properties"]
        trust = render(role["AssumeRolePolicyDocument"], params, conditions)["Statement"][0]
        self.assertEqual(trust["Principal"], {"Service": "pods.eks.amazonaws.com"})
        self.assertEqual(set(trust["Action"]), {"sts:AssumeRole", "sts:TagSession"})
        self.assertEqual(trust["Condition"]["StringEquals"], {
            "aws:RequestTag/eks-cluster-arn": f'arn:aws:eks:us-east-2:999000111222:cluster/{params["ClusterName"]}',
            "aws:RequestTag/kubernetes-namespace": params["Namespace"],
            "aws:RequestTag/kubernetes-service-account": params["ServiceAccount"],
        })
        statements = render(role["Policies"][0]["PolicyDocument"], params, conditions)["Statement"]
        self.assertEqual(statements[0]["Resource"], params["SigningKeyArn"])
        self.assertEqual(set(statements[0]["Action"]), {"kms:GetPublicKey", "kms:Sign"})
        self.assertEqual(statements[1]["Action"], "s3:ListBucket")
        self.assertEqual(statements[1]["Condition"]["StringLike"]["s3:prefix"], [params["BucketPrefix"], params["BucketPrefix"] + "/*"])
        association = resources["Association"]["Properties"]
        self.assertEqual(template["Outputs"]["AssociationId"]["Value"], {"Fn::GetAtt": ["Association", "AssociationId"]})
        self.assertFalse(association["DisableSessionTags"])
        self.assertEqual(association["RoleArn"], {"Fn::GetAtt": ["ProbeRole", "Arn"]})
        for parameter in ("ClusterName", "Namespace", "ServiceAccount"):
            self.assertEqual(association[parameter], {"Ref": parameter})
        with self.assertRaises(ValueError):
            CHECK.validate(template, filled("pod-identity-probe", ResourceClassification="production"))
        with self.assertRaises(ValueError):
            CHECK.validate(template, filled("pod-identity-probe", BucketPrefix="*"))

    def test_pod_identity_agent_does_not_overwrite_existing_addon_configuration(self):
        template = load("pod-identity-agent")
        self.assertEqual(len(template["Resources"]), 1)
        addon = template["Resources"]["Agent"]
        self.assertEqual(addon["Type"], "AWS::EKS::Addon")
        self.assertEqual(addon["Properties"]["ResolveConflicts"], "NONE")
        self.assertNotIn("ServiceAccountRoleArn", addon["Properties"])

    def test_application_grants_are_key_and_prefix_scoped(self):
        template, params, conditions = resolved("application-roles")
        policies = {key: render(item["Properties"]["Policies"][0]["PolicyDocument"], params, conditions)["Statement"] for key, item in template["Resources"].items() if item["Type"] == "AWS::IAM::Role"}
        kms = []
        for statements in policies.values():
            for stmt in statements:
                self.assertNotEqual(stmt["Resource"], "*")
                if isinstance(stmt["Action"], list) and "kms:Sign" in stmt["Action"]:
                    kms.append(stmt["Resource"])
        self.assertEqual(len(set(kms)), 5)
        coordinator = policies["ProofCoordinatorRole"]
        self.assertIn("s3:DeleteObject", coordinator[0]["Action"])
        self.assertEqual(coordinator[1]["Condition"]["StringLike"]["s3:prefix"], [params["ProofPrefix"], params["ProofPrefix"] + "/*"])
        wp = json.dumps(policies["WithdrawalProcessorRole"])
        self.assertNotIn("s3:DeleteObject", wp)
        self.assertNotIn("s3:ListBucket", wp)
        da = json.dumps(policies["EthDaRole"])
        self.assertIn("scroll-chunk-segmentation-sidecars-by-height/*", da)
        with self.assertRaises(ValueError):
            CHECK.validate(template, filled("application-roles", ProofPrefix="*"))

    def test_secret_reader_cannot_write_or_read_entire_account(self):
        template, params, conditions = resolved("secrets-reader-role")
        statements = render(template["Resources"]["ReaderRole"]["Properties"]["Policies"][0]["PolicyDocument"], params, conditions)["Statement"]
        self.assertEqual(len(statements), 1)
        self.assertEqual(set(statements[0]["Action"]), {"secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"})
        self.assertTrue(statements[0]["Resource"].endswith(":secret:example-chain/*"))
        self.assertNotIn("kms:Decrypt", json.dumps(statements))
        _, params, conditions = resolved("secrets-reader-role", SecretEncryptionKeyArn="arn:aws:kms:us-east-2:999000111222:key/11111111-1111-1111-1111-111111111111")
        statements = render(template["Resources"]["ReaderRole"]["Properties"]["Policies"][0]["PolicyDocument"], params, conditions)["Statement"]
        self.assertEqual(statements[1]["Condition"]["StringEquals"]["kms:ViaService"], "secretsmanager.us-east-2.amazonaws.com")
        self.assertIn("kms:EncryptionContext:SecretARN", statements[1]["Condition"]["StringLike"])

    def test_dstack_cannot_launch_without_project_or_in_other_subnets(self):
        template, params, conditions = resolved("dstack-role")
        statements = render(template["Resources"]["ControllerRole"]["Properties"]["Policies"][0]["PolicyDocument"], params, conditions)["Statement"]
        launch = next(s for s in statements if s.get("Sid") == "LaunchTaggedWorkers")
        self.assertEqual(launch["Condition"]["StringEquals"]["aws:RequestTag/dstack_project"], params["Project"])
        deps = next(s for s in statements if s.get("Sid") == "LaunchDependencies")
        subnets = [arn for arn in deps["Resource"] if ":subnet/" in arn]
        self.assertEqual(len(subnets), 2)
        self.assertTrue(all("*" not in arn for arn in subnets))
        self.assertNotIn("iam:PassRole", json.dumps(statements))
        self.assertNotIn("ec2:AllocateAddress", json.dumps(statements))
        with self.assertRaisesRegex(ValueError, "both worker"):
            CHECK.validate(template, filled("dstack-role", WorkerRoleArn="arn:aws:iam::999000111222:role/worker"))

    def test_tso_routes_do_not_expose_admin_or_metrics(self):
        template, params, conditions = resolved("http-target", "http-target.tso", PathPatterns="/*")
        route_conditions = render(template["Resources"]["Route"]["Properties"]["Conditions"], params, conditions)
        paths = route_conditions[1]["PathPatternConfig"]["Values"]
        self.assertEqual(paths, ["/health", "/signer", "/signer/*"])
        self.assertFalse(any(path in paths for path in ("/*", "/metrics", "/admin")))
        self.assertNotIn("AWS::ElasticLoadBalancingV2::LoadBalancer", [r["Type"] for r in template["Resources"].values()])

    def test_alb_default_denies_unmatched_routes_and_keeps_proof_timeout(self):
        template = load("https-alb")
        listener = template["Resources"]["Listener"]["Properties"]
        self.assertEqual(listener["DefaultActions"][0]["FixedResponseConfig"]["StatusCode"], "404")
        self.assertEqual((listener["Protocol"], listener["Port"]), ("HTTPS", 443))
        attrs = {x["Key"]: x["Value"] for x in template["Resources"]["LoadBalancer"]["Properties"]["LoadBalancerAttributes"]}
        self.assertGreaterEqual(int(attrs["idle_timeout.timeout_seconds"]), 120)
        self.assertEqual(attrs["deletion_protection.enabled"], "true")
        self.assertEqual(template["Resources"]["SecurityGroup"]["Properties"]["SecurityGroupIngress"], [])

    def test_nlb_is_closed_by_default_and_uses_existing_eips(self):
        template, _, conditions = resolved("bootnode-nlb", PeerIpv4Cidr="")
        self.assertFalse(conditions["HasPeer"])
        types = [r["Type"] for r in template["Resources"].values()]
        self.assertNotIn("AWS::EC2::EIP", types)
        group = template["Resources"]["TargetGroup"]["Properties"]
        self.assertEqual((group["Protocol"], group["Port"], group["TargetType"]), ("TCP", 30303, "ip"))
        attrs = {x["Key"]: x["Value"] for x in group["TargetGroupAttributes"]}
        self.assertEqual(attrs["proxy_protocol_v2.enabled"], "false")
        self.assertEqual(attrs["load_balancing.cross_zone.enabled"], "true")
        with self.assertRaises(ValueError):
            CHECK.validate(template, filled("bootnode-nlb", PeerIpv4Cidr="0.0.0.0/0"))

    def test_alb_supports_three_backend_availability_zones(self):
        for third, count in (("", 2), ("subnet-0123456789abcdef2", 3)):
            template, params, conditions = resolved("https-alb", SubnetC=third)
            subnets = render(template["Resources"]["LoadBalancer"]["Properties"]["Subnets"], params, conditions)
            self.assertEqual(len(subnets), count)
            if third:
                self.assertIn(third, subnets)
        for duplicate in ("subnet-0123456789abcdef0", "subnet-0123456789abcdef1"):
            with self.assertRaises(ValueError):
                CHECK.validate(load("https-alb"), filled("https-alb", SubnetC=duplicate))

    def test_invalid_network_parameters_fail_before_change_set(self):
        template = load("https-alb")
        for overrides in ({"ClientIpv4Cidr": "10.0.0.7/24"}, {"ClientIpv4Cidr": "0.0.0.0/0"}, {"BackendPortFrom": 4000}, {"Scheme": "internet-facing"}, {"SubnetB": "subnet-0123456789abcdef0"}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                CHECK.validate(template, filled("https-alb", **overrides))

    def test_no_bucket_secret_value_or_runtime_compute_creation(self):
        forbidden = {"AWS::S3::Bucket", "AWS::S3::BucketPolicy", "AWS::EC2::Instance", "AWS::EKS::Cluster", "AWS::EC2::VPC"}
        for path in ROOT.glob("*.yaml"):
            template = yaml.safe_load(path.read_text())
            for resource in template["Resources"].values():
                if resource["Type"] == "AWS::SecretsManager::Secret":
                    self.assertNotIn("SecretString", resource["Properties"])
                    self.assertNotIn("GenerateSecretString", resource["Properties"])
            self.assertTrue(forbidden.isdisjoint(r["Type"] for r in template["Resources"].values()))


if __name__ == "__main__":
    unittest.main()
