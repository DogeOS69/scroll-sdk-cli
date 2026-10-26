"""Lifecycle grouping must preserve retention, trust and internal references."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('assemble', ROOT / 'assemble-stacks.py')
ASSEMBLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSEMBLE)


class LifecycleStacks(unittest.TestCase):
    def test_generated_templates_are_current(self):
        subprocess.run(['python', str(ROOT / 'assemble-stacks.py'), '--check'], check=True)

    def test_all_five_durable_keys_are_opt_in_and_retained(self):
        template = ASSEMBLE.assemble('signing-identities')
        keys = [x for x in template['Resources'].values() if x['Type'] == 'AWS::KMS::Key']
        self.assertEqual(len(keys), 5)
        for key in keys:
            self.assertEqual(key['DeletionPolicy'], 'Retain')
            self.assertEqual(key['UpdateReplacePolicy'], 'Retain')
            condition = template['Conditions'][key['Condition']]['Fn::Equals']
            self.assertEqual(condition[1], 'create')
            self.assertEqual(template['Parameters'][condition[0]['Ref']]['Default'], 'reuse')

    def test_access_stack_cannot_allocate_keys_storage_or_network(self):
        for recipe, count in [('workload-access', 6), ('capacity-access', 1)]:
            resources = ASSEMBLE.assemble(recipe)['Resources']
            self.assertEqual(len(resources), count * 2)
            self.assertEqual({x['Type'] for x in resources.values()}, {'AWS::IAM::Role', 'AWS::EKS::PodIdentityAssociation'})

    def test_capacity_listener_is_connected_within_its_stack(self):
        template = ASSEMBLE.assemble('capacity-network')
        self.assertNotIn('ControllerListenerArn', template['Parameters'])
        rules = [x for x in template['Resources'].values() if x['Type'] == 'AWS::ElasticLoadBalancingV2::ListenerRule']
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]['Properties']['ListenerArn'], {'Ref': 'HttpsListener'})
        self.assertEqual(template['Parameters']['HttpsScheme']['AllowedValues'], ['internal'])
        self.assertEqual(template['Outputs']['HttpsPrivateUrl'], {
            'Condition': 'HttpsHasPrivateDns',
            'Description': 'Certificate hostname for the private controller endpoint; never substitute the ALB DNS name.',
            'Value': {'Fn::Sub': 'https://${HttpsPrivateHostname}'},
        })
