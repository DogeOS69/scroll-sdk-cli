"""Pinned dstack 0.21.5 adapter. JSON input and sanitized JSON output only."""
import importlib.metadata
import json
import os
import pathlib
import sys
import time

from dstack.api.server import APIClient
from dstack._internal.core.errors import ResourceNotExistsError
from dstack._internal.core.models.fleets import FleetSpec
from dstack._internal.core.models.profiles import Profile
from dstack._internal.core.models.runs import RunSpec


def lookup(fn):
    try:
        return fn()
    except ResourceNotExistsError:
        return None


def owned(client, plan, worker):
    project = plan['project']
    run = lookup(lambda: client.runs.get(project, worker['name']))
    fleet = lookup(lambda: client.fleets.get(project, worker['fleet']['name']))
    if run and run.run_spec.configuration.env.model_dump().get('SCROLLSDK_WORKER_PLAN_ID') != plan['id']:
        raise ValueError('Run ownership conflict')
    if fleet and (fleet.spec.configuration.tags or {}).get('scrollsdk-plan') != plan['id']:
        raise ValueError('Fleet ownership conflict')
    return run, fleet


def snapshot(client, plan):
    rows = []
    for worker in plan['workers']:
        run, fleet = owned(client, plan, worker)
        rows.append({'name': worker['name'], 'run': run.status.value if run else 'absent',
                     'fleet': fleet.status.value if fleet else 'absent',
                     'instances': [{'name': i.name, 'status': i.status.value, 'pricePerHourUsd': i.price}
                                   for i in fleet.instances] if fleet else []})
    return rows


def cleanup(client, plan, worker, abort=True):
    run, fleet = owned(client, plan, worker)
    try:
        if run and not run.status.is_finished():
            client.runs.stop(plan['project'], [worker['name']], abort=abort)
    finally:
        if fleet and (abort or not run or run.status.is_finished()):
            client.fleets.delete(plan['project'], [worker['fleet']['name']])


def guard_tick(client, plan, started, now):
    """Absolute deadlines survive watchdog process restarts; no local CLI lease."""
    elapsed = now - started
    startup = plan['config']['startupTimeoutMinutes'] * 60
    stop_at = startup + plan['config']['maxDurationHours'] * 3600
    force_at = stop_at + plan['config']['stopTimeoutMinutes'] * 60
    all_gone = True
    failed = False
    for worker in plan['workers']:
        try:
            run, fleet = owned(client, plan, worker)
            gone = (not run or run.status.is_finished()) and (not fleet or fleet.status.value == 'terminated')
            all_gone = all_gone and gone
            if elapsed >= force_at:
                cleanup(client, plan, worker)
            elif elapsed >= stop_at:
                cleanup(client, plan, worker, abort=False)
            elif run and run.status.is_finished():
                cleanup(client, plan, worker)
            elif elapsed >= startup and (not run or run.status.value in ('submitted', 'pending', 'provisioning', 'pulling')):
                cleanup(client, plan, worker)
        except Exception:
            failed = True
    if failed:
        raise RuntimeError('One or more owned resources could not be reconciled')
    # Do not finish during the initial submission gap, or let a late apply rent
    # after the watchdog has exited. Applications must start within startup.
    return all_gone and elapsed >= startup


def main(payload):
    if importlib.metadata.version('dstack') != '0.21.5':
        raise ValueError('This lifecycle adapter requires dstack 0.21.5')
    plan = payload['plan']
    action = payload['action']
    client = APIClient(base_url=os.environ.get('SCROLLSDK_DSTACK_URL', 'http://127.0.0.1:3000'),
                       token=os.environ['DSTACK_SERVER_ADMIN_TOKEN'])
    project = plan['project']
    if action == 'status':
        return {'workers': snapshot(client, plan)}
    if action == 'destroy':
        failed = False
        for worker in plan['workers']:
            try:
                cleanup(client, plan, worker)
            except Exception:
                failed = True
        if failed:
            raise RuntimeError('Some resources need another cleanup attempt')
        return {'workers': snapshot(client, plan), 'cleanupRequested': True}
    if action == 'guard':
        while True:
            try:
                done = guard_tick(client, plan, payload['startedAt'], time.time())
                pathlib.Path('/tmp/scrollsdk-watchdog-ready').touch()
                if done:
                    client.secrets.delete(project, [plan['secretName']])
                    return {'cleaned': True}
            except Exception:
                # Never emit provider errors: they may echo secrets. Keep trying
                # indefinitely; an API outage does not mean resources are gone.
                print('Cleanup/status API unavailable; retrying', file=sys.stderr, flush=True)
            time.sleep(30)
    if action != 'apply':
        raise ValueError('Unsupported operation')
    if time.time() >= payload['startedAt'] + plan['config']['startupTimeoutMinutes'] * 60:
        raise ValueError('Submission window expired; destroy and start a new session')
    # Validate every configuration before any cloud-side write.
    definitions = [(worker, FleetSpec(configuration=worker['fleet'], profile=Profile(name='default')),
                    RunSpec(run_name=worker['name'], configuration=worker['task'], profile=Profile(name='default')))
                   for worker in plan['workers']]
    for worker, _, _ in definitions:
        run, fleet = owned(client, plan, worker)
        if run and run.status.is_finished():
            raise ValueError('Completed runs are never restarted by apply; use a new session')
        if fleet and fleet.status.value in ('terminating', 'terminated'):
            raise ValueError('Retired fleets are never recreated by apply')
    client.secrets.create_or_update(project, plan['secretName'], payload['token'])
    attempted = []
    try:
        for worker, fleet_spec, run_spec in definitions:
            run, fleet = owned(client, plan, worker)
            if run:
                if run.run_spec.configuration.model_dump() != run_spec.configuration.model_dump():
                    raise ValueError('Existing run configuration differs from the plan')
                continue
            attempted.append(worker)
            if not fleet:
                client.fleets.apply_plan(project, client.fleets.get_plan(project, fleet_spec))
            elif fleet.spec.configuration.model_dump() != fleet_spec.configuration.model_dump():
                raise ValueError('Existing fleet configuration differs from the plan')
            client.runs.apply_plan(project, client.runs.get_plan(project, run_spec, max_offers=5))
    except Exception:
        for worker in attempted:
            try:
                cleanup(client, plan, worker)
            except Exception:
                pass  # The independent watchdog retries after API recovery.
        raise
    return {'workers': snapshot(client, plan)}


if __name__ == '__main__':
    try:
        payload = json.loads(os.environ['SCROLLSDK_GUARD_PAYLOAD']) if 'SCROLLSDK_GUARD_PAYLOAD' in os.environ else json.load(sys.stdin)
        print(json.dumps(main(payload)))
    except Exception:
        print('Dstack operation failed; use proof-workers status to reconcile (private API details omitted)', file=sys.stderr)
        sys.exit(1)
