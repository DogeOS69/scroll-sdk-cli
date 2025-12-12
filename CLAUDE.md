# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Scroll SDK CLI (`scrollsdk`) is a tool for configuring, managing, and testing DogeOS/Scroll SDK deployments. It's built with the [oclif](https://oclif.io) CLI framework in TypeScript and manages Kubernetes-based blockchain infrastructure including L1 (Dogecoin), L2 (EVM rollup), Celestia DA, and bridge services.

## Build and Development Commands

```bash
# Build the project (compiles TypeScript to dist/)
yarn build

# Watch mode for development
yarn dev  # or yarn watch

# Run linting
yarn lint

# Run all tests
yarn test

# Run a single test file
yarn mocha --forbid-only "test/path/to/file.test.ts"

# Run CLI commands during development (after building)
./bin/run.js <command>
```

## Architecture

### Command Structure

Commands follow oclif conventions in `src/commands/` with topic-based organization:
- `setup/` - Infrastructure setup (domains, db-init, configs, prep-charts, push-secrets, tls)
- `doge/` - Dogecoin-specific operations (config, wallet/, bridge-init, dummy-signers)
- `helper/` - Utility commands (activity, fund-accounts, set-scalars)
- `test/` - Testing commands (contracts, e2e, dogeos, ingress, dependencies)
- `check/` - Prerequisite checks

### Key Utilities

- `src/utils/config-parser.ts` - TOML/YAML config file parsing
- `src/utils/non-interactive.ts` - Non-interactive mode support with `$ENV:VAR_NAME` pattern for secrets
- `src/utils/json-output.ts` - Structured JSON output for automation (`--json` flag)
- `src/utils/onchain-helpers.ts` - Ethereum/L2 chain interactions via ethers.js
- `src/utils/deployment-spec-generator.ts` - Generates configs from DeploymentSpec YAML
- `src/utils/values-generator.ts` - Generates Helm values files

### DeploymentSpec System

The `DeploymentSpec` type (`src/types/deployment-spec.ts`) is the single source of truth for deployments. It generates:
- `config.toml` - Main CLI configuration
- `doge-config.toml` - Dogecoin settings
- `setup_defaults.toml` - Bridge setup parameters
- `values/*.yaml` - Helm chart values

Use `scrollsdk setup generate-from-spec --spec deployment-spec.yaml` for automated config generation.

### Non-Interactive Mode

Commands support `--non-interactive` and `--json` flags for CI/CD pipelines:
- Missing required values fail fast with structured error messages
- Use `$ENV:VAR_NAME` syntax in config files to reference environment variables
- JSON output goes to stdout, logs to stderr

## Configuration Files

The CLI reads/writes these files (typically in working directory):
- `config.toml` - Main configuration (L1/L2 endpoints, chain IDs, accounts)
- `config-contracts.toml` - Deployed contract addresses
- `.data/doge-config.toml` - Dogecoin wallet and network settings
- `values/` - Helm chart values for Kubernetes deployment

## Testing Notes

Integration tests require a running deployment. Unit tests in `test/` use mocha/chai. ES modules with sinon stubbing has limitations - prefer integration testing for command behavior.
