const { spawn } = require('node:child_process');
const { Buffer } = require('node:buffer');
const { tmpdir } = require('node:os');

const MAX_BYTES = 16 * 1024 * 1024;

// Discovery only: callers must not create sessions or send inference requests.
function openRpc(command, args, framing = 'lines', timeoutMs = 60000, env = {}) {
  const child = spawn(command, args, {
    cwd: tmpdir(),
    env: { ...process.env, NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  let failure;
  let closing = false;
  const pending = new Map();

  function fail(error) {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    child.kill();
  }

  function receive(message) {
    if (framing === 'claude') {
      if (message.type === 'control_request') {
        throw new Error('Unexpected Claude control request during model discovery');
      }
      if (message.type !== 'control_response') return;
      const response = message.response;
      message = response.subtype === 'success'
        ? { id: Number(response.request_id), result: response.response }
        : { id: Number(response.request_id), error: { code: 'initialization-failed' } };
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new Error(`${command} ${request.method}: RPC error ${message.error.code ?? 'unknown'}`));
    } else if ('result' in message) {
      request.resolve(message.result);
    } else {
      request.reject(new Error(`${command}: invalid RPC response`));
    }
  }

  child.on('error', (error) => fail(new Error(`${command}: ${error.code ?? error.message}`)));
  child.on('exit', (code, signal) => {
    if (!closing) fail(new Error(`${command} exited during discovery (${signal ?? code})`));
  });
  child.stdin.on('error', (error) => {
    if (!closing) fail(new Error(`${command} stdin: ${error.code ?? error.message}`));
  });
  child.stderr.resume();
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      if (buffer.length > MAX_BYTES) throw new Error('Discovery response exceeds 16 MiB');
      while (buffer.length) {
        let start = 0;
        let end;
        let consumed;
        if (framing === 'headers') {
          const boundary = buffer.indexOf('\r\n\r\n');
          if (boundary < 0) break;
          const match = /^Content-Length:\s*(\d+)$/im.exec(buffer.subarray(0, boundary).toString());
          if (!match) throw new Error('Missing RPC Content-Length');
          start = boundary + 4;
          end = start + Number(match[1]);
          if (end > MAX_BYTES) throw new Error('Discovery response exceeds 16 MiB');
          if (buffer.length < end) break;
          consumed = end;
        } else {
          end = buffer.indexOf('\n');
          if (end < 0) break;
          consumed = end + 1;
        }
        const text = buffer.subarray(start, end).toString('utf8').trim();
        buffer = buffer.subarray(consumed);
        if (text) receive(JSON.parse(text));
      }
    } catch (error) {
      fail(new Error(`${command}: malformed discovery response (${error.message})`));
    }
  });

  function send(message) {
    const body = JSON.stringify(framing === 'claude'
      ? { type: 'control_request', request_id: String(message.id), request: { subtype: message.method, ...message.params } }
      : { jsonrpc: '2.0', ...message });
    child.stdin.write(framing === 'headers'
      ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      : `${body}\n`);
  }

  return {
    request(method, params = {}) {
      if (failure) return Promise.reject(failure);
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`${command} ${method}: discovery timed out`)), timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        send({ id, method, params });
      });
    },
    notify(method, params = {}) { send({ method, params }); },
    close() {
      closing = true;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`${command}: discovery closed`));
      }
      pending.clear();
      child.stdin.end();
      child.kill();
    },
  };
}

module.exports = { openRpc };
