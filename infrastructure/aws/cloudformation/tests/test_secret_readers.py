"""Reader grants must not turn a legacy Secret exception into account-wide access."""
import fnmatch
import json
import unittest

from test_templates import CHECK, filled, load, render, resolved


TEMPLATES = ("secrets-reader-policy", "secrets-reader-role")
LEGACY = "arn:aws:secretsmanager:us-east-2:999000111222:secret:legacy/fixture/proof-AbCdEf"
SECOND = "arn:aws:secretsmanager:us-east-2:999000111222:secret:legacy/fixture/other-GhIjKl"
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
    def test_only_deployment_prefix_and_exact_exceptions_can_be_read(self):
        current = "arn:aws:secretsmanager:us-east-2:999000111222:secret:dogeos/fixture/database-AbCdEf"
        for name in TEMPLATES:
            with self.subTest(template=name):
                policy = statements(name, AdditionalSecretArns=LEGACY + "," + SECOND)
                for arn in (current, LEGACY, SECOND):
                    for action in ("GetSecretValue", "DescribeSecret"):
                        self.assertTrue(allows_secret(policy, "secretsmanager:" + action, arn))
                for arn in (current.replace("/fixture/", "/another-deployment/"),
                            current.replace("/fixture/", "/fixture-copy/"),
                            current.replace("us-east-2", "us-west-2"),
                            current.replace("999000111222", "999000111223"),
                            LEGACY.replace("AbCdEf", "GhIjKl"), LEGACY + "-copy"):
                    self.assertFalse(allows_secret(policy, "secretsmanager:GetSecretValue", arn))
                for action in ("PutSecretValue", "CreateSecret", "DeleteSecret", "TagResource",
                               "UntagResource", "UpdateSecret", "PutResourcePolicy", "RotateSecret",
                               "ListSecrets", "BatchGetSecretValue"):
                    for arn in (current, LEGACY):
                        self.assertFalse(allows_secret(policy, "secretsmanager:" + action, arn))

    def test_optional_legacy_grant_and_decryption_are_absent_by_default(self):
        for name in TEMPLATES:
            with self.subTest(template=name):
                policy = statements(name)
                self.assertEqual(len(policy), 1)
                self.assertFalse(allows_secret(policy, "secretsmanager:GetSecretValue", LEGACY))
                self.assertNotIn("kms:", json.dumps(policy))
                self.assertEqual(len(statements(name, AdditionalSecretArns=LEGACY)), 2)
                # Existing parameter files that omit the new input retain their grant.
                entries = [x for x in filled(name) if x["ParameterKey"] != "AdditionalSecretArns"]
                self.assertEqual(CHECK.validate(load(name), entries)["AdditionalSecretArns"], "")

    def test_decryption_is_only_for_selected_key_service_and_secret_contexts(self):
        for name in TEMPLATES:
            for extra in ("", LEGACY + "," + SECOND):
                with self.subTest(template=name, additional=bool(extra)):
                    policy = statements(name, AdditionalSecretArns=extra, SecretEncryptionKeyArn=KEY)
                    decrypt = [s for s in policy if s["Action"] == "kms:Decrypt"]
                    self.assertEqual(len(decrypt), 2 if extra else 1)
                    for grant in decrypt:
                        self.assertEqual(grant["Resource"], KEY)
                        self.assertEqual(grant["Condition"]["StringEquals"]["kms:ViaService"],
                                         "secretsmanager.us-east-2.amazonaws.com")
                    self.assertEqual(decrypt[0]["Condition"]["StringLike"]["kms:EncryptionContext:SecretARN"],
                                     "arn:aws:secretsmanager:us-east-2:999000111222:secret:dogeos/fixture/*")
                    if extra:
                        self.assertEqual(decrypt[1]["Condition"]["StringEquals"]["kms:EncryptionContext:SecretARN"],
                                         [LEGACY, SECOND])
                    self.assertNotIn("kms:Sign", json.dumps(policy))

    def test_rejects_wildcards_partial_arns_and_malformed_lists(self):
        invalid = ("*", "legacy/fixture/proof", LEGACY.replace("AbCdEf", "*"),
                   LEGACY.replace("AbCdEf", "??????"), LEGACY.replace("999000111222", "*"),
                   LEGACY.replace(":secret:", ":parameter:"), LEGACY + ",", "," + LEGACY,
                   LEGACY + ",," + SECOND, LEGACY + ", " + SECOND)
        for name in TEMPLATES:
            for value in invalid:
                with self.subTest(template=name, value=value), self.assertRaisesRegex(ValueError, "AdditionalSecretArns"):
                    CHECK.validate(load(name), filled(name, AdditionalSecretArns=value))

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
