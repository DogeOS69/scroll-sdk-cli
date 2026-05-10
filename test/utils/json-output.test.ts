import { expect } from 'chai';
import sinon from 'sinon';

import {
  CliExitError,
  JsonOutputContext,
  createErrorResponse,
  createSuccessResponse,
  getErrorMeta,
} from '../../src/utils/json-output.js';

describe('json-output utilities', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('CliExitError', () => {
    it('sets all properties from ErrorResponse', () => {
      const response = {
        command: 'test-cmd',
        error: {
          category: 'CONFIGURATION' as const,
          code: 'E101_CONFIG_NOT_FOUND',
          context: { path: '/missing/file' },
          message: 'Config not found',
          recoverable: true,
        },
        success: false as const,
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      const err = new CliExitError(response);

      expect(err).to.be.instanceOf(Error);
      expect(err.name).to.equal('CliExitError');
      expect(err.message).to.equal('Config not found');
      expect(err.code).to.equal('E101_CONFIG_NOT_FOUND');
      expect(err.category).to.equal('CONFIGURATION');
      expect(err.recoverable).to.be.true;
      expect(err.context).to.deep.equal({ path: '/missing/file' });
      expect(err.response).to.deep.equal(response);
    });

    it('works without context', () => {
      const response = {
        command: 'cmd',
        error: {
          category: 'INTERNAL' as const,
          code: 'E900_UNEXPECTED_ERROR',
          message: 'Something failed',
          recoverable: false,
        },
        success: false as const,
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      const err = new CliExitError(response);
      expect(err.context).to.be.undefined;
    });
  });

  describe('JsonOutputContext', () => {
    describe('constructor and isJsonEnabled', () => {
      it('defaults jsonEnabled to false', () => {
        const ctx = new JsonOutputContext('cmd');
        expect(ctx.isJsonEnabled).to.be.false;
      });

      it('respects jsonEnabled parameter', () => {
        const ctx = new JsonOutputContext('cmd', true);
        expect(ctx.isJsonEnabled).to.be.true;
      });
    });

    describe('addWarning', () => {
      it('accumulates warnings', () => {
        const ctx = new JsonOutputContext('cmd', true);
        ctx.addWarning('warn1');
        ctx.addWarning('warn2');

        const stdoutStub = sinon.stub(console, 'log');
        ctx.success({ result: 'ok' });

        const output = JSON.parse(stdoutStub.firstCall.args[0]);
        expect(output.warnings).to.deep.equal(['warn1', 'warn2']);
      });

      it('logs to stderr in non-JSON mode', () => {
        const stderrStub = sinon.stub(console, 'error');
        const ctx = new JsonOutputContext('cmd', false);
        ctx.addWarning('something went wrong');

        expect(stderrStub.calledOnce).to.be.true;
      });

      it('does not log to stderr in JSON mode', () => {
        const stderrStub = sinon.stub(console, 'error');
        const ctx = new JsonOutputContext('cmd', true);
        ctx.addWarning('quiet warning');

        expect(stderrStub.called).to.be.false;
      });
    });

    describe('error', () => {
      it('throws CliExitError', () => {
        const ctx = new JsonOutputContext('test-cmd', true);
        sinon.stub(console, 'log');

        expect(() => {
          ctx.error('E101_CONFIG_NOT_FOUND', 'Config missing', 'CONFIGURATION', true);
        }).to.throw(CliExitError);
      });

      it('outputs JSON to stdout in JSON mode', () => {
        const ctx = new JsonOutputContext('test-cmd', true);
        const stdoutStub = sinon.stub(console, 'log');

        try {
          ctx.error('E300_L1_RPC_UNREACHABLE', 'RPC down', 'NETWORK', true, { url: 'http://rpc' });
        } catch { /* expected */ }

        expect(stdoutStub.calledOnce).to.be.true;
        const output = JSON.parse(stdoutStub.firstCall.args[0]);
        expect(output.success).to.be.false;
        expect(output.command).to.equal('test-cmd');
        expect(output.error.code).to.equal('E300_L1_RPC_UNREACHABLE');
        expect(output.error.message).to.equal('RPC down');
        expect(output.error.category).to.equal('NETWORK');
        expect(output.error.recoverable).to.be.true;
        expect(output.error.context).to.deep.equal({ url: 'http://rpc' });
        expect(output.duration_ms).to.be.a('number');
        expect(output.timestamp).to.be.a('string');
      });

      it('outputs human-readable to stderr in non-JSON mode', () => {
        const ctx = new JsonOutputContext('test-cmd', false);
        const stderrStub = sinon.stub(console, 'error');

        try {
          ctx.error('E900_UNEXPECTED_ERROR', 'boom', 'INTERNAL', false);
        } catch { /* expected */ }

        expect(stderrStub.callCount).to.be.greaterThan(0);
      });

      it('omits context from response when not provided', () => {
        const ctx = new JsonOutputContext('cmd', true);
        const stdoutStub = sinon.stub(console, 'log');

        try {
          ctx.error('E900_UNEXPECTED_ERROR', 'oops', 'INTERNAL', false);
        } catch { /* expected */ }

        const output = JSON.parse(stdoutStub.firstCall.args[0]);
        expect(output.error.context).to.be.undefined;
      });

      it('includes duration_ms in error response', () => {
        const ctx = new JsonOutputContext('cmd', true);
        const stdoutStub = sinon.stub(console, 'log');

        try {
          ctx.error('E900_UNEXPECTED_ERROR', 'msg', 'INTERNAL', false);
        } catch { /* expected */ }

        const output = JSON.parse(stdoutStub.firstCall.args[0]);
        expect(output.duration_ms).to.be.a('number');
        expect(output.duration_ms).to.be.at.least(0);
      });
    });

    describe('info', () => {
      it('logs to stdout in non-JSON mode', () => {
        const ctx = new JsonOutputContext('cmd', false);
        const stdoutStub = sinon.stub(console, 'log');
        ctx.info('hello');
        expect(stdoutStub.calledOnce).to.be.true;
      });

      it('logs to stderr in JSON mode', () => {
        const ctx = new JsonOutputContext('cmd', true);
        const stderrStub = sinon.stub(console, 'error');
        ctx.info('hello');
        expect(stderrStub.calledOnce).to.be.true;
      });
    });

    describe('log', () => {
      it('logs to stdout in non-JSON mode', () => {
        const ctx = new JsonOutputContext('cmd', false);
        const stdoutStub = sinon.stub(console, 'log');
        ctx.log('message');
        expect(stdoutStub.calledOnce).to.be.true;
      });

      it('logs to stderr in JSON mode', () => {
        const ctx = new JsonOutputContext('cmd', true);
        const stderrStub = sinon.stub(console, 'error');
        ctx.log('message');
        expect(stderrStub.calledOnce).to.be.true;
      });
    });

    describe('success', () => {
      it('outputs JSON response to stdout in JSON mode', () => {
        const ctx = new JsonOutputContext('test-cmd', true);
        const stdoutStub = sinon.stub(console, 'log');

        ctx.success({ items: [1, 2, 3] });

        expect(stdoutStub.calledOnce).to.be.true;
        const output = JSON.parse(stdoutStub.firstCall.args[0]);
        expect(output.success).to.be.true;
        expect(output.command).to.equal('test-cmd');
        expect(output.data).to.deep.equal({ items: [1, 2, 3] });
        expect(output.duration_ms).to.be.a('number');
        expect(output.timestamp).to.be.a('string');
      });

      it('does not output anything in non-JSON mode', () => {
        const ctx = new JsonOutputContext('cmd', false);
        const stdoutStub = sinon.stub(console, 'log');
        const stderrStub = sinon.stub(console, 'error');

        ctx.success({ result: 'ok' });

        expect(stdoutStub.called).to.be.false;
        expect(stderrStub.called).to.be.false;
      });

      it('includes warnings when present', () => {
        const ctx = new JsonOutputContext('cmd', true);
        ctx.addWarning('minor issue');
        const stdoutStub = sinon.stub(console, 'log');

        ctx.success({ done: true });

        const output = JSON.parse(stdoutStub.firstCall.args[0]);
        expect(output.warnings).to.deep.equal(['minor issue']);
      });

      it('omits warnings field when no warnings', () => {
        const ctx = new JsonOutputContext('cmd', true);
        const stdoutStub = sinon.stub(console, 'log');

        ctx.success({ done: true });

        const output = JSON.parse(stdoutStub.firstCall.args[0]);
        expect(output.warnings).to.be.undefined;
      });
    });
  });

  describe('getErrorMeta', () => {
    it('returns metadata for known error codes', () => {
      const meta = getErrorMeta('E101_CONFIG_NOT_FOUND');
      expect(meta.category).to.equal('CONFIGURATION');
      expect(meta.recoverable).to.be.true;
    });

    it('returns INTERNAL for unknown error codes', () => {
      const meta = getErrorMeta('E900_UNEXPECTED_ERROR');
      expect(meta.category).to.equal('INTERNAL');
      expect(meta.recoverable).to.be.false;
    });

    it('returns correct metadata for network errors', () => {
      const meta = getErrorMeta('E300_L1_RPC_UNREACHABLE');
      expect(meta.category).to.equal('NETWORK');
      expect(meta.recoverable).to.be.true;
    });

    it('returns correct metadata for non-recoverable errors', () => {
      const meta = getErrorMeta('E401_DOCKER_CONTAINER_FAILED');
      expect(meta.category).to.equal('DOCKER');
      expect(meta.recoverable).to.be.false;
    });
  });

  describe('createErrorResponse', () => {
    it('builds a well-formed error response', () => {
      const response = createErrorResponse(
        'setup:db-init',
        'E304_DATABASE_UNREACHABLE',
        'Cannot connect to DB',
        'NETWORK',
        true,
        { host: 'db.example.com' }
      );

      expect(response.success).to.be.false;
      expect(response.command).to.equal('setup:db-init');
      expect(response.error.code).to.equal('E304_DATABASE_UNREACHABLE');
      expect(response.error.message).to.equal('Cannot connect to DB');
      expect(response.error.category).to.equal('NETWORK');
      expect(response.error.recoverable).to.be.true;
      expect(response.error.context).to.deep.equal({ host: 'db.example.com' });
      expect(response.timestamp).to.be.a('string');
    });

    it('omits context when not provided', () => {
      const response = createErrorResponse('cmd', 'E900', 'msg', 'INTERNAL', false);
      expect(response.error.context).to.be.undefined;
    });
  });

  describe('createSuccessResponse', () => {
    it('builds a well-formed success response', () => {
      const response = createSuccessResponse('setup gen-l2-artifacts', { generated: true }, 1234);

      expect(response.success).to.be.true;
      expect(response.command).to.equal('setup gen-l2-artifacts');
      expect(response.data).to.deep.equal({ generated: true });
      expect(response.duration_ms).to.equal(1234);
      expect(response.timestamp).to.be.a('string');
      expect(response.warnings).to.be.undefined;
    });

    it('includes warnings when provided', () => {
      const response = createSuccessResponse('cmd', {}, 100, ['warn1', 'warn2']);
      expect(response.warnings).to.deep.equal(['warn1', 'warn2']);
    });

    it('omits warnings for empty array', () => {
      const response = createSuccessResponse('cmd', {}, 100, []);
      expect(response.warnings).to.be.undefined;
    });
  });
});
