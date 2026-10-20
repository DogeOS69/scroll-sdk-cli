"""Offline probe checks with dstack 0.21.5; never contact an API/provider."""
import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import types
import unittest
from unittest.mock import patch, MagicMock

sys.dont_write_bytecode = True
source = pathlib.Path(__file__).resolve().parents[1] / 'src/config/capacity-manager-preflight.py'
spec = importlib.util.spec_from_file_location('capacity_probe', source)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.payload = {'url': 'https://controller.example.invalid', 'wpUrl': 'http://wp:9300',
                        'project': 'example', 'provider': 'vastai', 'privateDns': True}
        self.env = {'PROBE_INPUT': json.dumps(self.payload), 'DSTACK_TOKEN': 'nonfunctional-test-only',
                    'WP_TOKEN': 'nonfunctional-test-only', 'WORKER_MASTER': 'nonfunctional-test-only'}
        self.client = types.SimpleNamespace(projects=types.SimpleNamespace(get=lambda _: types.SimpleNamespace(
            backends=[types.SimpleNamespace(config=types.SimpleNamespace(type='vastai'))])))
        self.opener = MagicMock()
        response = self.opener.open.return_value.__enter__.return_value
        response.status = 200
        response.read.return_value = b'{"schema_version":1}'

    def run_probe(self, address='10.0.1.2'):
        output = io.StringIO()
        with patch.dict('os.environ', self.env), patch.object(probe.socket, 'getaddrinfo', return_value=[(None, None, None, None, (address, 443))]), patch('dstack.api.server.APIClient', return_value=self.client), patch.object(probe.urllib.request, 'build_opener', return_value=self.opener), contextlib.redirect_stdout(output):
            probe.main()
        return output.getvalue()

    def test_checks_do_not_print_credentials_or_responses(self):
        output = self.run_probe()
        self.assertNotIn('nonfunctional-test-only', output)
        self.assertNotIn('schema_version', output)
        self.assertEqual(json.loads(output)['wpCapacityApi'], 'passed')
        request = self.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://wp:9300/v1/proof-work/capacity/summary')
        self.assertEqual(self.opener.open.call_args.kwargs['timeout'], 20)

    def test_private_mode_rejects_public_or_loopback_dns(self):
        for address in ['8.8.8.8', '127.0.0.1']:
            with self.assertRaisesRegex(RuntimeError, 'Private endpoint'):
                self.run_probe(address)
        self.opener.open.assert_not_called()

    def test_empty_secret_or_missing_backend_fails_before_wp_call(self):
        self.env['WORKER_MASTER'] = ''
        with self.assertRaisesRegex(RuntimeError, 'empty Secret'):
            self.run_probe()
        self.env['WORKER_MASTER'] = 'nonfunctional-test-only'
        self.payload['provider'] = 'aws'
        self.env['PROBE_INPUT'] = json.dumps(self.payload)
        with self.assertRaisesRegex(RuntimeError, 'backend is absent'):
            self.run_probe()
        self.opener.open.assert_not_called()

    def test_redirect_cannot_forward_wp_authorization(self):
        with self.assertRaisesRegex(RuntimeError, 'Redirects'):
            probe.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example.invalid')


if __name__ == '__main__':
    unittest.main()
