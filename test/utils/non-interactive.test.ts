/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocking */
import { expect } from 'chai';
import sinon from 'sinon';

import { CliExitError } from '../../src/utils/json-output.js';
import {
  createNonInteractiveContext,
  isUnresolvedEnvRef,
  resolveConfirm,
  resolveEnvValue,
  resolveOrPrompt,
  resolveOrSelect,
  shouldSkipConfirmation,
  validateAndExit,
} from '../../src/utils/non-interactive.js';

describe('non-interactive utilities', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('createNonInteractiveContext', () => {
    it('creates context with defaults', () => {
      const ctx = createNonInteractiveContext('test-cmd', false);
      expect(ctx.command).to.equal('test-cmd');
      expect(ctx.enabled).to.be.false;
      expect(ctx.jsonOutput).to.be.false;
      expect(ctx.missingFields).to.deep.equal([]);
    });

    it('creates context with all options', () => {
      const ctx = createNonInteractiveContext('setup:configs', true, true);
      expect(ctx.command).to.equal('setup:configs');
      expect(ctx.enabled).to.be.true;
      expect(ctx.jsonOutput).to.be.true;
    });
  });

  describe('resolveEnvValue', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns undefined for undefined input', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      expect(resolveEnvValue(undefined)).to.be.undefined;
    });

    it('returns undefined for null input', () => {
      expect(resolveEnvValue(null as any)).to.be.undefined;
    });

    it('returns undefined for empty string', () => {
      expect(resolveEnvValue('')).to.be.undefined;
    });

    it('returns literal value when no $ENV: prefix', () => {
      expect(resolveEnvValue('my-value')).to.equal('my-value');
    });

    it('resolves $ENV:VAR_NAME to environment variable value', () => {
      process.env.TEST_SECRET = 'secret123';
      expect(resolveEnvValue('$ENV:TEST_SECRET')).to.equal('secret123');
    });

    it('returns undefined when referenced env var is not set', () => {
      delete process.env.NONEXISTENT_VAR;
      const stderrStub = sinon.stub(console, 'error');
      expect(resolveEnvValue('$ENV:NONEXISTENT_VAR')).to.be.undefined;
      expect(stderrStub.calledOnce).to.be.true;
    });

    it('returns undefined when referenced env var is empty', () => {
      process.env.EMPTY_VAR = '';
      const stderrStub = sinon.stub(console, 'error');
      expect(resolveEnvValue('$ENV:EMPTY_VAR')).to.be.undefined;
      expect(stderrStub.calledOnce).to.be.true;
    });

    it('does not resolve partial $ENV: patterns', () => {
      expect(resolveEnvValue('prefix$ENV:VAR')).to.equal('prefix$ENV:VAR');
    });

    it('does not resolve $ENV: followed by non-word characters', () => {
      expect(resolveEnvValue('$ENV:foo-bar')).to.equal('$ENV:foo-bar');
    });
  });

  describe('isUnresolvedEnvRef', () => {
    it('returns false for undefined', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      expect(isUnresolvedEnvRef(undefined)).to.be.false;
    });

    it('returns false for empty string', () => {
      expect(isUnresolvedEnvRef('')).to.be.false;
    });

    it('returns true for $ENV: prefix', () => {
      expect(isUnresolvedEnvRef('$ENV:MY_SECRET')).to.be.true;
    });

    it('returns false for literal values', () => {
      expect(isUnresolvedEnvRef('regular-value')).to.be.false;
    });

    it('returns false for partial $ENV in middle of string', () => {
      expect(isUnresolvedEnvRef('prefix$ENV:VAR')).to.be.false;
    });
  });

  describe('resolveOrPrompt', () => {
    it('calls promptFn in interactive mode', async () => {
      const ctx = createNonInteractiveContext('cmd', false);
      const promptFn = sinon.stub().resolves('prompted-value');

      const result = await resolveOrPrompt(ctx, promptFn, undefined, {
        configPath: '[db].HOST',
        description: 'Database host',
        field: 'HOST',
      });

      expect(result).to.equal('prompted-value');
      expect(promptFn.calledOnce).to.be.true;
    });

    it('returns config value in non-interactive mode', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub().resolves('should-not-be-called');

      const result = await resolveOrPrompt(ctx, promptFn, 'config-value', {
        configPath: '[db].HOST',
        description: 'Database host',
        field: 'HOST',
      });

      expect(result).to.equal('config-value');
      expect(promptFn.called).to.be.false;
    });

    it('resolves $ENV: references in non-interactive mode', async () => {
      process.env.TEST_DB_HOST = 'db.example.com';
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      const result = await resolveOrPrompt(ctx, promptFn, '$ENV:TEST_DB_HOST', {
        configPath: '[db].HOST',
        description: 'Database host',
        field: 'HOST',
      });

      expect(result).to.equal('db.example.com');
      delete process.env.TEST_DB_HOST;
    });

    it('records missing required field in non-interactive mode', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();
      const fieldMeta = {
        configPath: '[db].HOST',
        description: 'Database host',
        field: 'HOST',
      };

      const result = await resolveOrPrompt(ctx, promptFn, undefined, fieldMeta);

      expect(result).to.be.undefined;
      expect(ctx.missingFields).to.have.lengthOf(1);
      expect(ctx.missingFields[0]).to.deep.equal(fieldMeta);
    });

    it('does not record optional missing field', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      const result = await resolveOrPrompt(ctx, promptFn, undefined, {
        configPath: '[db].PORT',
        description: 'Database port',
        field: 'PORT',
      }, false);

      expect(result).to.be.undefined;
      expect(ctx.missingFields).to.have.lengthOf(0);
    });
  });

  describe('resolveOrSelect', () => {
    it('calls promptFn in interactive mode', async () => {
      const ctx = createNonInteractiveContext('cmd', false);
      const promptFn = sinon.stub().resolves('mainnet');

      const result = await resolveOrSelect(
        ctx, promptFn, undefined,
        ['mainnet', 'testnet'],
        { configPath: '[network]', description: 'Network', field: 'NETWORK' }
      );

      expect(result).to.equal('mainnet');
      expect(promptFn.calledOnce).to.be.true;
    });

    it('returns valid config value in non-interactive mode', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      const result = await resolveOrSelect(
        ctx, promptFn, 'testnet',
        ['mainnet', 'testnet'],
        { configPath: '[network]', description: 'Network', field: 'NETWORK' }
      );

      expect(result).to.equal('testnet');
      expect(promptFn.called).to.be.false;
    });

    it('records error for invalid choice in non-interactive mode', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      const result = await resolveOrSelect(
        ctx, promptFn, 'invalid-net',
        ['mainnet', 'testnet'],
        { configPath: '[network]', description: 'Network', field: 'NETWORK' }
      );

      expect(result).to.be.undefined;
      expect(ctx.missingFields).to.have.lengthOf(1);
      expect(ctx.missingFields[0].description).to.include('Valid values: mainnet, testnet');
      expect(ctx.missingFields[0].description).to.include('Got: "invalid-net"');
    });

    it('records missing required field when value is undefined', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      await resolveOrSelect(
        ctx, promptFn, undefined,
        ['mainnet', 'testnet'],
        { configPath: '[network]', description: 'Network', field: 'NETWORK' }
      );

      expect(ctx.missingFields).to.have.lengthOf(1);
      expect(ctx.missingFields[0].description).to.include('Valid values: mainnet, testnet');
    });
  });

  describe('resolveConfirm', () => {
    it('calls promptFn in interactive mode', async () => {
      const ctx = createNonInteractiveContext('cmd', false);
      const promptFn = sinon.stub().resolves(false);

      // eslint-disable-next-line unicorn/no-useless-undefined
      const result = await resolveConfirm(ctx, promptFn, undefined);

      expect(result).to.be.false;
      expect(promptFn.calledOnce).to.be.true;
    });

    it('returns default (true) when config value is undefined', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      // eslint-disable-next-line unicorn/no-useless-undefined
      expect(await resolveConfirm(ctx, promptFn, undefined)).to.be.true;
    });

    it('returns custom default when config value is undefined', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      expect(await resolveConfirm(ctx, promptFn, undefined, false)).to.be.false;
    });

    it('handles boolean config values', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      expect(await resolveConfirm(ctx, promptFn, true)).to.be.true;
      expect(await resolveConfirm(ctx, promptFn, false)).to.be.false;
    });

    it('handles string "true" variants', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      expect(await resolveConfirm(ctx, promptFn, 'true')).to.be.true;
      expect(await resolveConfirm(ctx, promptFn, 'yes')).to.be.true;
      expect(await resolveConfirm(ctx, promptFn, '1')).to.be.true;
      expect(await resolveConfirm(ctx, promptFn, 'TRUE')).to.be.true;
      expect(await resolveConfirm(ctx, promptFn, 'Yes')).to.be.true;
    });

    it('handles string "false" variants', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      expect(await resolveConfirm(ctx, promptFn, 'false')).to.be.false;
      expect(await resolveConfirm(ctx, promptFn, 'no')).to.be.false;
      expect(await resolveConfirm(ctx, promptFn, '0')).to.be.false;
      expect(await resolveConfirm(ctx, promptFn, 'FALSE')).to.be.false;
    });

    it('returns default for unrecognized string values', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      expect(await resolveConfirm(ctx, promptFn, 'maybe')).to.be.true;
      expect(await resolveConfirm(ctx, promptFn, 'maybe', false)).to.be.false;
    });

    it('returns default for empty string', async () => {
      const ctx = createNonInteractiveContext('cmd', true);
      const promptFn = sinon.stub();

      expect(await resolveConfirm(ctx, promptFn, '')).to.be.true;
    });
  });

  describe('validateAndExit', () => {
    it('returns normally when no fields are missing', () => {
      const ctx = createNonInteractiveContext('cmd', true, true);
      expect(() => validateAndExit(ctx)).to.not.throw();
    });

    it('throws CliExitError when fields are missing (JSON mode)', () => {
      const ctx = createNonInteractiveContext('cmd', true, true);
      ctx.missingFields.push({
        configPath: '[db].HOST',
        description: 'Database host',
        field: 'HOST',
      });

      const stdoutStub = sinon.stub(console, 'log');

      try {
        validateAndExit(ctx);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(CliExitError);
        const cliErr = error as CliExitError;
        expect(cliErr.code).to.equal('E601_MISSING_FIELD');
        expect(cliErr.category).to.equal('CONFIGURATION');
        expect(cliErr.recoverable).to.be.true;
        expect(cliErr.response.error.context?.missingFields).to.have.lengthOf(1);
      }

      // In JSON mode it outputs to stdout
      expect(stdoutStub.calledOnce).to.be.true;
      const output = JSON.parse(stdoutStub.firstCall.args[0]);
      expect(output.success).to.be.false;
      expect(output.error.code).to.equal('E601_MISSING_FIELD');
    });

    it('outputs human-readable error when not in JSON mode', () => {
      const ctx = createNonInteractiveContext('cmd', true, false);
      ctx.missingFields.push({
        configPath: '[db].HOST',
        description: 'Database host',
        field: 'HOST',
      });

      const stderrStub = sinon.stub(console, 'error');

      try {
        validateAndExit(ctx);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(CliExitError);
      }

      // Human-readable output goes to stderr
      expect(stderrStub.callCount).to.be.greaterThan(0);
    });

    it('includes all missing fields in error context', () => {
      const ctx = createNonInteractiveContext('cmd', true, true);
      ctx.missingFields.push(
        { configPath: '[db].HOST', description: 'Database host', field: 'HOST' },
        { configPath: '[db].PORT', description: 'Database port', field: 'PORT' },
      );

      sinon.stub(console, 'log');

      try {
        validateAndExit(ctx);
      } catch (error) {
        const cliErr = error as CliExitError;
        const missing = cliErr.response.error.context?.missingFields as any[];
        expect(missing).to.have.lengthOf(2);
        expect(missing[0].field).to.equal('HOST');
        expect(missing[1].field).to.equal('PORT');
      }
    });
  });

  describe('shouldSkipConfirmation', () => {
    it('returns true when non-interactive mode is enabled', () => {
      const ctx = createNonInteractiveContext('cmd', true);
      expect(shouldSkipConfirmation(ctx)).to.be.true;
    });

    it('returns false when non-interactive mode is disabled', () => {
      const ctx = createNonInteractiveContext('cmd', false);
      expect(shouldSkipConfirmation(ctx)).to.be.false;
    });
  });
});
