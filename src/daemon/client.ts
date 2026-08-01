import net from 'node:net';
import fs from 'node:fs/promises';
import { defaultProfileName, socketPath } from '../session/paths.js';
import { CliError } from '../io/errors.js';
import { makeRequestId, type Response } from './protocol.js';
import {
  SUPERVISOR_RPC_MAX_FRAME_BYTES,
  SUPERVISOR_RPC_RESPONSE_SCHEMA,
  SupervisorRpcError,
  type ParsedSupervisorRpcRequestV1,
  type SupervisorRpcResponseV1,
} from './supervisor-rpc.js';

const PING_TIMEOUT_MS = 800;
const CALL_TIMEOUT_MS = 5 * 60 * 1000;

export async function isDaemonReachable(profile?: string): Promise<boolean> {
  const profileName = defaultProfileName(profile);
  const sockPath = socketPath(profileName);
  // On Unix the socket is a file we can stat; on Windows the named pipe
  // (`\\.\pipe\...`) has no filesystem entry, so skip the existence check
  // and just try to connect.
  if (process.platform !== 'win32') {
    try {
      await fs.access(sockPath);
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, PING_TIMEOUT_MS);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function daemonCall<T>(
  cmd: string,
  args: unknown,
  requestId = makeRequestId(),
  profile?: string,
): Promise<T> {
  const profileName = defaultProfileName(profile);
  const sockPath = socketPath(profileName);
  return new Promise<T>((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error('daemon call timed out'));
    }, CALL_TIMEOUT_MS);

    function succeed(data: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.end();
      resolve(data);
    }

    function fail(e: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    }

    sock.on('connect', () => {
      const req = { id: requestId, cmd, args };
      sock.write(JSON.stringify(req) + '\n');
    });

    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      let resp: Response;
      try {
        resp = JSON.parse(line);
      } catch (e) {
        fail(new Error('daemon: malformed response'));
        return;
      }
      if (resp.ok) {
        succeed(resp.data as T);
      } else {
        fail(new CliError(resp.exitCode, resp.code, resp.message, resp.details));
      }
    });

    sock.on('error', (e) => {
      fail(e);
    });
  });
}

export async function supervisorDaemonCall<T>(
  request: ParsedSupervisorRpcRequestV1,
  profile?: string,
  signal?: AbortSignal,
): Promise<T> {
  const profileName = defaultProfileName(profile);
  const sockPath = socketPath(profileName);
  if (signal?.aborted) {
    throw new SupervisorRpcError('RPC_CANCELLED', 'RPC was cancelled before connect.', true);
  }
  const frame = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(frame) > SUPERVISOR_RPC_MAX_FRAME_BYTES) {
    throw new SupervisorRpcError('RPC_FRAME_TOO_LARGE', 'RPC request exceeds its size limit.', false);
  }
  const timeoutMs = Math.max(1, Date.parse(request.deadlineAt) - Date.now());
  return new Promise<T>((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      sock.destroy();
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = (): void => finish(
      new SupervisorRpcError('RPC_CANCELLED', 'RPC was cancelled.', true),
    );
    const timer = setTimeout(() => finish(
      new SupervisorRpcError('RPC_RESPONSE_TIMEOUT', 'RPC deadline expired.', true),
    ), timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    sock.once('connect', () => sock.write(frame));
    sock.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > SUPERVISOR_RPC_MAX_FRAME_BYTES) {
        finish(new SupervisorRpcError('RPC_FRAME_TOO_LARGE', 'RPC response exceeds its size limit.', false));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let response: SupervisorRpcResponseV1<T>;
      try {
        response = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as SupervisorRpcResponseV1<T>;
      } catch {
        finish(new SupervisorRpcError('RPC_MALFORMED_RESPONSE', 'RPC response is not JSON.', false));
        return;
      }
      if (
        response.schema !== SUPERVISOR_RPC_RESPONSE_SCHEMA
        || response.rpcId !== request.rpcId
      ) {
        finish(new SupervisorRpcError(
          'RPC_RESPONSE_BINDING_MISMATCH',
          'RPC response schema or id differs from the request.',
          false,
        ));
        return;
      }
      if (response.ok) finish(undefined, response.data);
      else finish(new SupervisorRpcError(
        response.error.code,
        response.error.message,
        response.error.retryable,
        response.error.details,
      ));
    });
    sock.once('error', (error) => finish(error));
    sock.once('close', () => {
      if (!settled) finish(new SupervisorRpcError(
        'RPC_SOCKET_CLOSED',
        'RPC socket closed before a complete response.',
        true,
      ));
    });
  });
}
