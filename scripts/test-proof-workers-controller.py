"""Offline native-model and lifecycle checks. Requires dstack==0.21.5; no API calls.

Run: uv run --with dstack==0.21.5 python scripts/test-proof-workers-controller.py
"""
import importlib.util
import copy
import pathlib
import types
import sys
sys.dont_write_bytecode = True
import unittest
from unittest.mock import patch

from dstack._internal.core.errors import ResourceNotExistsError
from dstack._internal.core.models.fleets import FleetSpec, FleetStatus
from dstack._internal.core.models.profiles import Profile
from dstack._internal.core.models.runs import RunSpec, RunStatus

source = pathlib.Path(__file__).resolve().parents[1] / 'src/config/proof-workers-controller.py'
spec = importlib.util.spec_from_file_location('worker_controller', source)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def plan():
    resources = {'cpu': '8..', 'memory': '64GB..', 'disk': '200GB..',
                 'gpu': {'name': 'RTX3090', 'count': 1, 'memory': '24GB..'}}
    fleet = {'type': 'fleet', 'name': 'test-gpu', 'nodes': '0..1', 'resources': resources,
             'backends': ['vastai'], 'max_price': 0.8, 'idle_duration': 300, 'retry': False,
             'tags': {'scrollsdk-plan': 'test'},
             'backend_options': [{'type': 'vastai', 'offer_order': 'price', 'min_reliability': 0.95}]}
    task = {'type': 'task', 'name': 'test-worker', 'nodes': 1, 'fleets': ['test-gpu'],
            'image': 'example.invalid/worker@sha256:' + 'a' * 64, 'resources': resources,
            'max_duration': 7200, 'stop_duration': 780, 'idle_duration': 300,
            'max_price': 0.8, 'backends': ['vastai'], 'retry': False, 'commands': ['true'],
            'env': {'SCROLLSDK_WORKER_PLAN_ID': 'test'}}
    return {'id': 'test', 'project': 'example', 'secretName': 'test_secret',
            'config': {'startupTimeoutMinutes': 30, 'maxDurationHours': 2, 'stopTimeoutMinutes': 13},
            'workers': [{'name': 'test-worker', 'fleet': fleet, 'task': task}]}


class Client:
    def __init__(self):
        self.run = None
        self.fleet = None
        self.calls = []
        self.ambiguous = False
        self.runs = types.SimpleNamespace(get=self.get_run, stop=self.stop,
                                        get_plan=lambda project, value, **kw: value, apply_plan=self.apply_run)
        self.fleets = types.SimpleNamespace(get=self.get_fleet, delete=self.delete,
                                          get_plan=lambda project, value: value, apply_plan=self.apply_fleet)
        self.secrets = types.SimpleNamespace(create_or_update=lambda *a: self.calls.append('secret'))

    def get_run(self, *_args):
        if not self.run:
            raise ResourceNotExistsError()
        return self.run

    def get_fleet(self, *_args):
        if not self.fleet:
            raise ResourceNotExistsError()
        return self.fleet

    def apply_fleet(self, project, value):
        self.calls.append('create-fleet')
        self.fleet = types.SimpleNamespace(spec=value, status=FleetStatus.ACTIVE, instances=[])

    def apply_run(self, project, value):
        self.calls.append('create-run')
        self.run = types.SimpleNamespace(run_spec=value, status=RunStatus.RUNNING)
        if self.ambiguous:
            raise TimeoutError('response lost after creation')

    def stop(self, project, names, abort):
        self.calls.append(('stop', names, abort))

    def delete(self, project, names):
        self.calls.append(('delete', names))


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.plan = plan()
        self.payload = {'action': 'apply', 'plan': self.plan, 'startedAt': 1000, 'token': 'disposable-test-only'}

    def apply(self):
        with patch.object(adapter, 'APIClient', return_value=self.client), patch.dict('os.environ', {'DSTACK_SERVER_ADMIN_TOKEN': 'disposable-test-only'}), patch.object(adapter.time, 'time', return_value=1100):
            return adapter.main(self.payload)

    def test_native_model_zero_minimum_and_deadlines(self):
        fleet = FleetSpec(configuration=self.plan['workers'][0]['fleet'], profile=Profile(name='default'))
        run = RunSpec(configuration=self.plan['workers'][0]['task'], profile=Profile(name='default'))
        self.assertEqual((fleet.configuration.nodes.min, fleet.configuration.nodes.max), (0, 1))
        self.assertEqual(run.configuration.max_duration, 7200)
        self.assertEqual(run.configuration.stop_duration, 780)
        self.assertFalse(run.configuration.retry)

    def test_native_aws_l4_models_and_repeated_apply(self):
        worker = self.plan['workers'][0]
        worker['fleet'].pop('backend_options')
        for config in (worker['fleet'], worker['task']):
            config.update(backends=['aws'], regions=['us-east-1'], instance_types=['g6.4xlarge'],
                          spot_policy='on-demand', max_price=1.5)
            config['resources'] = {'cpu': 'x86:16..', 'memory': '64GB..', 'disk': '200GB..',
                                   'gpu': {'name': 'L4', 'count': 1, 'memory': '22GB..'}}
        self.apply()
        self.apply()
        for config in (self.client.fleet.spec.configuration, self.client.run.run_spec.configuration):
            self.assertEqual(config.instance_types, ['g6.4xlarge'])
            self.assertEqual([backend.value for backend in config.backends], ['aws'])
            self.assertEqual(config.spot_policy.value, 'on-demand')
        self.assertEqual(self.client.fleet.spec.configuration.resources.cpu.arch.value, 'x86')
        self.assertEqual(self.client.calls.count('create-fleet'), 1)
        self.assertEqual(self.client.calls.count('create-run'), 1)

    def test_repeat_apply_preserves_one_allocation(self):
        self.apply()
        self.apply()
        self.assertEqual(self.client.calls.count('create-fleet'), 1)
        self.assertEqual(self.client.calls.count('create-run'), 1)

    def test_terminal_run_is_not_restarted(self):
        self.apply()
        self.client.run.status = RunStatus.DONE
        with self.assertRaisesRegex(ValueError, 'never restarted'):
            self.apply()
        self.assertEqual(self.client.calls.count('create-run'), 1)

    def test_ambiguous_submission_attempts_cleanup(self):
        self.client.ambiguous = True
        with self.assertRaises(TimeoutError):
            self.apply()
        self.assertIn(('stop', ['test-worker'], True), self.client.calls)
        self.assertIn(('delete', ['test-gpu']), self.client.calls)

    def test_watchdog_does_not_exit_before_submission(self):
        self.assertFalse(adapter.guard_tick(self.client, self.plan, 1000, 1100))
        self.assertTrue(adapter.guard_tick(self.client, self.plan, 1000, 2900))

    def test_stalled_startup_aborts(self):
        self.apply()
        self.client.run.status = RunStatus.PROVISIONING
        adapter.guard_tick(self.client, self.plan, 1000, 2801)
        self.assertIn(('stop', ['test-worker'], True), self.client.calls)
        self.assertIn(('delete', ['test-gpu']), self.client.calls)

    def test_running_deadline_then_force_cleanup_after_drain(self):
        self.apply()
        adapter.guard_tick(self.client, self.plan, 1000, 10001)
        self.assertIn(('stop', ['test-worker'], False), self.client.calls)
        self.assertNotIn(('delete', ['test-gpu']), self.client.calls)
        adapter.guard_tick(self.client, self.plan, 1000, 10781)
        self.assertIn(('stop', ['test-worker'], True), self.client.calls)
        self.assertIn(('delete', ['test-gpu']), self.client.calls)

    def test_failed_run_deletes_fleet(self):
        self.apply()
        self.client.run.status = RunStatus.FAILED
        adapter.guard_tick(self.client, self.plan, 1000, 1200)
        self.assertIn(('delete', ['test-gpu']), self.client.calls)

    def test_no_cleanup_of_foreign_resources(self):
        self.apply()
        self.client.run.run_spec.configuration.env.root['SCROLLSDK_WORKER_PLAN_ID'] = 'foreign'
        with self.assertRaisesRegex(RuntimeError, 'reconciled'):
            adapter.guard_tick(self.client, self.plan, 1000, 20000)
        self.assertFalse(any(isinstance(c, tuple) for c in self.client.calls))

    def test_force_delete_is_attempted_even_when_run_stop_fails(self):
        self.apply()
        self.client.runs.stop = lambda *a, **kw: (_ for _ in ()).throw(TimeoutError())
        with self.assertRaises(TimeoutError):
            adapter.cleanup(self.client, self.plan, self.plan['workers'][0])
        self.assertIn(('delete', ['test-gpu']), self.client.calls)

    def test_destroy_continues_after_one_worker_fails(self):
        self.apply()
        second = copy.deepcopy(self.plan['workers'][0])
        second['name'] = 'second-worker'
        second['fleet']['name'] = 'second-gpu'
        self.plan['workers'].append(second)
        def stop(project, names, abort):
            self.client.calls.append(('stop', names, abort))
            if names == ['test-worker']:
                raise TimeoutError()
        self.client.runs.stop = stop
        self.payload['action'] = 'destroy'
        with self.assertRaisesRegex(RuntimeError, 'cleanup'):
            self.apply()
        self.assertIn(('stop', ['second-worker'], True), self.client.calls)
        self.assertIn(('delete', ['second-gpu']), self.client.calls)

    def test_auth_failure_does_not_become_resource_absence(self):
        self.client.runs.get = lambda *a: (_ for _ in ()).throw(PermissionError())
        with self.assertRaises(PermissionError):
            self.apply()
        self.assertEqual(self.client.calls, [])


if __name__ == '__main__':
    unittest.main()
