"""External infrastructure actions preserve policy and credentials on retry."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]

def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

POLICY = module('render-artifact-policy')
SECRET = module('initialize-proof-secret')
APPLY = module('apply-artifact-policy')

class ExternalActions(unittest.TestCase):
    def test_preserves_complete_policy_and_retry(self):
        original = {'Version': '2012-10-17', 'Id': 'operator', 'Statement': [{'Sid': 'Existing', 'Effect': 'Deny', 'Action': '*', 'Resource': '*', 'Principal': '*'}]}
        before = json.dumps(original)
        template = POLICY.render(original, 'fixture-bucket', 'fixture/prefix', 'proof')
        policy = template['Resources']['ArtifactPolicy']['Properties']['PolicyDocument']
        self.assertEqual(policy['Statement'][:-1], original['Statement'])
        self.assertEqual(json.dumps(original), before)
        self.assertEqual(POLICY.render({'Policy': json.dumps(policy)}, 'fixture-bucket', 'fixture/prefix', 'proof'), template)
        self.assertEqual(len(policy['Statement'][-1]['Resource']), 8)
        self.assertEqual(policy['Statement'][-1]['Condition'], {'Bool': {'aws:SecureTransport': 'true'}})
        policy['Statement'][-1]['Action'] = '*'
        with self.assertRaises(ValueError): POLICY.render(policy, 'fixture-bucket', 'fixture/prefix', 'proof')
        for prefix in ['', '*', 'prefix/*', '${variable}']:
            with self.assertRaises(ValueError): POLICY.render({}, 'fixture-bucket', prefix, 'archive')

    def test_secret_init_never_reads_or_rotates_credentials(self):
        calls = []
        version = {}
        def run(args, **kwargs):
            calls.append((args, kwargs.get('input')))
            if 'describe-secret' in args:
                data = {'ARN': 'arn:aws:secretsmanager:us-east-2:999000111222:secret:fixture', 'VersionIdsToStages': version}
            else:
                self.assertIn('put-secret-value', args)
                payload = json.loads(Path(args[args.index('--cli-input-json') + 1].removeprefix('file://')).read_text())
                credentials = json.loads(payload['SecretString'])
                self.assertEqual(set(credentials), {'proof-work-token', 'prover-worker-master'})
                self.assertTrue(all(len(v) == 64 and v not in ' '.join(args) for v in credentials.values()))
                version[payload['ClientRequestToken']] = ['AWSCURRENT']
                data = {'VersionId': payload['ClientRequestToken']}
            return SimpleNamespace(returncode=0, stdout=json.dumps(data))
        first = SECRET.initialize('fixture', 'us-east-2', run=run)
        second = SECRET.initialize('fixture', 'us-east-2', run=run)
        self.assertIn('Initialized', first)
        self.assertIn('preserved', second)
        self.assertEqual(len(calls), 3)
        self.assertFalse(any('get-secret-value' in args for args, _ in calls))
        self.assertEqual(len(version), 1)

    def test_policy_apply_checks_drift_and_retries_without_writes(self):
        before = {'Version': '2012-10-17', 'Statement': []}
        template = POLICY.render(before, 'fixture-bucket', 'fixture/prefix', 'archive')
        current = before
        writes = []
        def run(args, **kwargs):
            nonlocal current
            if 'put-bucket-policy' in args:
                current = json.loads(args[args.index('--policy') + 1]); writes.append(current)
                result = {}
            else: result = {'Policy': json.dumps(current)}
            return SimpleNamespace(returncode=0, stdout=json.dumps(result))
        self.assertIn('applied', APPLY.apply(template, before, 'us-east-1', run=run))
        self.assertIn('no changes', APPLY.apply(template, before, 'us-east-1', run=run))
        self.assertEqual(len(writes), 1)
        current = {'Statement': [{'Sid': 'ConcurrentChange'}]}
        with self.assertRaisesRegex(ValueError, 'changed since review'):
            APPLY.apply(template, before, 'us-east-1', run=run)
        self.assertEqual(len(writes), 1)

    def test_provider_errors_do_not_expose_credentials(self):
        def run(args, **kwargs): return SimpleNamespace(returncode=1, stderr='PRIVATE_PROVIDER_DATA')
        with self.assertRaisesRegex(ValueError, '^Secrets Manager request failed; provider output omitted$'):
            SECRET.initialize('fixture', 'us-east-2', run=run)
