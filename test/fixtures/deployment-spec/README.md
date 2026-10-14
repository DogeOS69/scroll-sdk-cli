# DeploymentSpec test fixtures

`minimal.yaml` and `full.yaml` are test inputs for CLI field validation, generation,
and preparation workflows. Tests replace environment references and provider inputs
with disposable or mocked values. They are not deployment templates and do not need
to mirror every production example setting.

Operator spec and environment templates are maintained only in
[scroll-sdk/examples](https://github.com/DogeOS69/scroll-sdk/tree/v0.3.0-develop/examples).
Use those templates and their deployment guide when preparing a real deployment.
