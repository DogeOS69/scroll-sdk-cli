# Repository instructions

## Public repository: protect secrets

This is a public repository. Treat every tracked file, commit, pull request,
comment, CI log, and published artifact as publicly accessible.

- Never commit or publish private keys, seed phrases, API keys, access tokens,
  passwords, cloud credentials, signer sessions, kubeconfig credentials, or
  credential-bearing connection strings and webhook URLs. This applies to
  source code, configuration, examples, tests, documentation, deployment
  records, logs, screenshots, generated files, and published npm packages.
- Base64 encoding, encryption with a committed key, or putting a value in a
  Kubernetes `Secret` does not make it safe to commit. Do not embed credentials
  in `data`, `stringData`, URLs, or command examples.
- Templates and examples must use clearly nonfunctional placeholders or
  references to externally managed secrets. Prefer the CLI's existing
  `$ENV:VAR_NAME` convention, environment variables, or external Secret
  references. Tests must use fake placeholders or generate disposable
  credentials at runtime.
- The CLI may generate real credentials for an explicitly authorized deployment,
  but it must keep them in the operator's intended secret destination, outside
  tracked source and published package content. Avoid including secret values
  in normal logs, JSON diagnostics, errors, fixtures, or configuration previews.
- Keep real deployment secrets outside this checkout whenever possible. If a
  local secret-bearing file is necessary, exclude it from Git before writing
  it and never force-add it. `.gitignore` does not protect already tracked
  files or remove secrets from Git history.
- Before staging, committing, or pushing, review the changed files and staged
  diff for secrets, including generated files and package content. Stage
  intended files explicitly; do not blindly stage the entire working tree.
  Use an available secret scanner as an additional check, not a replacement
  for reviewing the actual changes.
- Read only the credentials needed for the authorized task. Do not print their
  values in terminal output, reports, chat messages, PR descriptions, or logs.
  Report the affected file or configuration field without reproducing a secret.
- If a secret is found in a proposed change, remove or replace it before the
  change is committed or published. If it was already committed or published,
  notify the user without quoting it and recommend revocation or rotation;
  deleting the current file alone does not remove historical exposure. Do not
  rewrite shared Git history or rotate deployed credentials without explicit
  authorization.
