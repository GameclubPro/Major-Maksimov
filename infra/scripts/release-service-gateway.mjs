#!/usr/bin/env node

import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
import { validateReleaseRequest } from './release-operation-store.mjs';

export const RELEASE_CONTROL_SOCKET = '/run/maxim-release/control.sock';
export const MAX_SUBMIT_BYTES = 65536;
export const MAX_CONTROL_WIRE_BYTES = 131072;
export const GATEWAY_TIMEOUT_MS = 20000;
const UUID_V4 = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const STATUS_COMMAND = new RegExp(`^status (${UUID_V4})$`, 'u');
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export class ReleaseGatewayError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new ReleaseGatewayError(code);
}

export function parseReleaseSshCommand(command) {
  // FLAG: Parse the forced SSH command as a finite protocol, never as shell text.
  // Exact spacing and a lowercase v4 identity leave no argument expansion path.
  if (typeof command !== 'string' || command.length > 43 || /[\r\n\0]/u.test(command))
    fail('COMMAND_NOT_ALLOWED');
  if (command === 'inventory' || command === 'submit') return { operation: command };
  const status = STATUS_COMMAND.exec(command);
  if (status?.[0] === command) return { operation: 'status', id: status[1] };
  fail('COMMAND_NOT_ALLOWED');
}

function decodeJson(buffer, code) {
  try {
    // FLAG: Decode only after the complete bounded byte stream is available.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    fail(code);
  }
}

export function readSubmitInput(input, { timeoutMs = GATEWAY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.removeListener('close', onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        input.on('error', () => {});
        input.destroy();
        reject(error);
      } else resolve(value);
    };
    const onData = (chunk) => {
      if (!Buffer.isBuffer(chunk)) {
        finish(new ReleaseGatewayError('INPUT_INVALID'));
        return;
      }
      bytes += chunk.length;
      if (bytes > MAX_SUBMIT_BYTES) {
        finish(new ReleaseGatewayError('INPUT_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const request = validateReleaseRequest(
          decodeJson(Buffer.concat(chunks, bytes), 'INPUT_INVALID'),
        );
        finish(null, request);
      } catch {
        finish(new ReleaseGatewayError('INPUT_INVALID'));
      }
    };
    const onError = () => finish(new ReleaseGatewayError('INPUT_FAILED'));
    const onClose = () => finish(new ReleaseGatewayError('INPUT_CLOSED'));
    const timer = setTimeout(() => finish(new ReleaseGatewayError('INPUT_TIMEOUT')), timeoutMs);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.once('close', onClose);
    input.resume();
  });
}

export function validateControlResponse(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_CONTROL_WIRE_BYTES)
    fail('RESPONSE_TOO_LARGE');
  const newline = buffer.indexOf(10);
  if (newline < 0) fail('RESPONSE_INCOMPLETE');
  if (buffer.subarray(newline + 1).some((byte) => ![9, 10, 13, 32].includes(byte)))
    fail('RESPONSE_INVALID');
  const response = decodeJson(buffer.subarray(0, newline), 'RESPONSE_INVALID');
  if (
    response === null ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    response.schemaVersion !== 1 ||
    typeof response.ok !== 'boolean'
  )
    fail('RESPONSE_INVALID');
  const keys = Object.keys(response).sort().join(',');
  if (response.ok) {
    if (keys !== 'ok,result,schemaVersion') fail('RESPONSE_INVALID');
  } else if (
    keys !== 'error,ok,schemaVersion' ||
    response.error === null ||
    typeof response.error !== 'object' ||
    Array.isArray(response.error) ||
    Object.keys(response.error).join(',') !== 'code' ||
    typeof response.error.code !== 'string' ||
    !SAFE_CODE.test(response.error.code)
  )
    fail('RESPONSE_INVALID');
  return response;
}

export function exchangeControlFrame(
  frame,
  { socketPath = RELEASE_CONTROL_SOCKET, timeoutMs = GATEWAY_TIMEOUT_MS } = {},
) {
  const wire = Buffer.from(`${JSON.stringify(frame)}\n`);
  if (wire.length > MAX_CONTROL_WIRE_BYTES) fail('REQUEST_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new ReleaseGatewayError('RESPONSE_TIMEOUT')), timeoutMs);
    socket.once('connect', () => {
      socket.write(wire);
    });
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CONTROL_WIRE_BYTES) {
        finish(new ReleaseGatewayError('RESPONSE_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    socket.once('end', () => {
      try {
        finish(null, validateControlResponse(Buffer.concat(chunks, bytes)));
      } catch (error) {
        finish(error);
      }
    });
    socket.once('error', () => finish(new ReleaseGatewayError('SERVICE_UNAVAILABLE')));
    socket.once('close', () => finish(new ReleaseGatewayError('RESPONSE_INCOMPLETE')));
  });
}

export async function runReleaseGateway({
  command,
  input = process.stdin,
  socketPath = RELEASE_CONTROL_SOCKET,
  timeoutMs = GATEWAY_TIMEOUT_MS,
}) {
  const frame = parseReleaseSshCommand(command);
  if (frame.operation === 'submit') frame.request = await readSubmitInput(input, { timeoutMs });
  return exchangeControlFrame(frame, { socketPath, timeoutMs });
}

export function productionGatewayInvocation(argv, env) {
  if (argv.length !== 0) fail('ARGUMENTS_NOT_ALLOWED');
  // FLAG: Only SSH_ORIGINAL_COMMAND is read; no environment value can select a socket or executable.
  return { command: env.SSH_ORIGINAL_COMMAND, socketPath: RELEASE_CONTROL_SOCKET };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const response = await runReleaseGateway(
      productionGatewayInvocation(process.argv.slice(2), process.env),
    );
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof ReleaseGatewayError ? error.code : 'GATEWAY_FAILED';
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: { code } })}\n`);
    process.exitCode = 1;
  }
}
