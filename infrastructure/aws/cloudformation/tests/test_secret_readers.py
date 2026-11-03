"""ESO readers may read only their deployment's Secrets, with optional decryption."""
import fnmatch
import json
import unittest

from test_templates import CHECK, filled, load, render, resolved


TEMPLATES = ("secrets-reader-policy", "secrets-reader-role")
KEY = "arn:aws:kms:us-east-2:999000111222:key/11111111-1111-1111-1111-111111111111"


def statements(name, **overrides):
    template, params, conditions = resolved(name, SecretPrefix="dogeos/fixture", **overrides)
    resource = template["Resources"]["ReaderPolicy" if name.endswith("policy") else "ReaderRole"]
    document = (resource["Properties"]["PolicyDocument"] if name.endswith("policy")
                else resource["Properties"]["Policies"][0]["PolicyDocument"])
    return render(document, params, conditions)["Statement"]


def allows_secret(policy, action, arn):
    """Evaluate the unconditional Allow statements used for Secrets Manager reads."""
    for statement in policy:
        if statement["Effect"] != "Allow" or statement.get("Condition"):
            continue
        actions = statement["Action"]
        resources = statement["Resource"]
        actions = actions if isinstance(actions, list) else [actions]
        resources = resources if isinstance(resources, list) else [resources]
        if any(fnmatch.fnmatchcase(action, pattern) for pattern in actions) and any(
                fnmatch.fnmatchcase(arn, pattern) for pattern in resources):
            return True
    return False


class SecretReaderBoundaries(unittest.TestCase):
    def test_only_deployment_prefix_can_be_read_without_write_access(self):
        current = "arn:aws:secretsmanager:us-east-2:999000111222:secret:dogeos/fixture/database-AbCdEf"
        for name in TEMPLATES:
            with self.subTest(template=name):
                policy = statements(name)
                for arn in (current, current.replace("database", "proof-coordinator")):
                    for action in ("GetSecretValue", "DescribeSecret"):
                        self.assertTrue(allows_secret(policy, "secretsmanager:" + action, arn))
                for arn in (current.replace("/fixture/", "/another-deployment/"),
                            current.replace("/fixture/", "/fixture-copy/"),
                            current.replace("us-east-2", "us-west-2"),
                            current.replace("999000111222", "999000111223"),
                            current.replace("dogeos/fixture/", "shared/")):
                    self.assertFalse(allows_secret(policy, "secretsmanager:GetSecretValue", arn))
                for action in ("PutSecretValue", "CreateSecret", "DeleteSecret", "TagResource",
                               "UntagResource", "UpdateSecret", "PutResourcePolicy", "RotateSecret",
                               "ListSecrets", "BatchGetSecretValue"):
                    self.assertFalse(allows_secret(policy, "secretsmanager:" + action, current))

    def test_decryption_is_absent_by_default(self):
        for name in TEMPLATES:
            with self.subTest(template=name):
                policy = statements(name)
                self.assertEqual(len(policy), 1)
                self.assertNotIn("kms:", json.dumps(policy))
                self.assertEqual(CHECK.validate(load(name), filled(name))["SecretEncryptionKeyArn"], "")

    def test_decryption_is_only_for_selected_key_service_and_secret_contexts(self):
        for name in TEMPLATES:
            with self.subTest(template=name):
                policy = statements(name, SecretEncryptionKeyArn=KEY)
                decrypt = [s for s in policy if s["Action"] == "kms:Decrypt"]
                self.assertEqual(len(decrypt), 1)
                grant = decrypt[0]
                self.assertEqual(grant["Resource"], KEY)
                self.assertEqual(grant["Condition"]["StringEquals"]["kms:ViaService"],
                                 "secretsmanager.us-east-2.amazonaws.com")
                self.assertEqual(grant["Condition"]["StringLike"]["kms:EncryptionContext:SecretARN"],
                                 "arn:aws:secretsmanager:us-east-2:999000111222:secret:dogeos/fixture/*")
                self.assertNotIn("kms:Sign", json.dumps(policy))

    def test_rejects_empty_prefix_wildcards_and_ambiguous_slashes(self):
        invalid = ("", "*", "dogeos/*", "dogeos/fixture?", "/dogeos/fixture",
                   "dogeos/fixture/", "dogeos//fixture")
        for name in TEMPLATES:
            for value in invalid:
                with self.subTest(template=name, value=value), self.assertRaisesRegex(ValueError, "SecretPrefix"):
                    CHECK.validate(load(name), filled(name, SecretPrefix=value))

    def test_existing_role_template_only_adds_its_own_managed_policy(self):
        template, params, conditions = resolved("secrets-reader-policy")
        self.assertEqual(set(template["Resources"]), {"ReaderPolicy"})
        resource = template["Resources"]["ReaderPolicy"]
        self.assertEqual(resource["Type"], "AWS::IAM::ManagedPolicy")
        self.assertEqual(render(resource["Properties"]["Roles"], params, conditions), ["fixture-eso-role"])
        self.assertNotIn("ManagedPolicyName", resource["Properties"])
        self.assertEqual(resource["Properties"]["Description"], {
            "Fn::Sub": "DogeOS ${Environment} ${ResourceClassification} Secret reader grant"})


if __name__ == "__main__":
    unittest.main()
