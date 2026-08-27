const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { TextDecoder } = require("node:util");

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_REASSEMBLED_BYTES = 67_108_864;

function withTimeout(promise, milliseconds, message) {
  let timeout;
  const guarded = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(resolve, reject);
  });
  return guarded.finally(() => clearTimeout(timeout));
}

class RpcProcess extends EventEmitter {
  #child = null;
  #chunk = null;
  #closed = false;
  #maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
  #maxReassembledBytes = DEFAULT_MAX_REASSEMBLED_BYTES;
  #pending = new Map();
  #ready = Promise.withResolvers();
  #stdoutBuffer = "";

  constructor({ command, args = [], cwd, env = process.env }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
  }

  async start() {
    if (this.#child) {
      throw new Error("The OMP RPC process is already running.");
    }

    this.#child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    this.#child.stderr.on("data", (text) => {
      this.emit("frame", { type: "stderr", text });
    });
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (exitCode, signal) => this.#handleExit(exitCode, signal));

    const ready = await withTimeout(
      this.#ready.promise,
      30_000,
      "OMP RPC did not emit its ready frame within 30 seconds.",
    );
    if (ready.supportedProtocolVersions?.includes(2)) {
      const response = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
      if (!response.success) {
        throw new Error(response.error || "OMP rejected RPC protocol v2 negotiation.");
      }
    }
    return ready;
  }

  request(command, timeout = 60_000) {
    if (!command || typeof command !== "object" || typeof command.type !== "string") {
      return Promise.reject(new Error("Invalid OMP RPC command."));
    }
    const id = randomUUID();
    const pending = Promise.withResolvers();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      pending.reject(new Error(`OMP RPC command ${command.type} timed out.`));
    }, timeout);
    this.#pending.set(id, {
      resolve: (frame) => {
        clearTimeout(timer);
        pending.resolve(frame);
      },
      reject: (error) => {
        clearTimeout(timer);
        pending.reject(error);
      },
    });

    try {
      this.send({ ...command, id });
    } catch (error) {
      this.#pending.delete(id);
      clearTimeout(timer);
      pending.reject(error);
    }
    return pending.promise;
  }

  send(frame) {
    if (!this.#child || this.#closed || !this.#child.stdin.writable) {
      throw new Error("OMP RPC is not running.");
    }
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.#maxFrameBytes) {
      throw new Error("OMP RPC command exceeds the advertised frame limit.");
    }
    this.#child.stdin.write(line);
  }

  async stop() {
    if (!this.#child || this.#closed) {
      return;
    }
    this.#closed = true;
    const child = this.#child;
    const exited = Promise.withResolvers();
    child.once("exit", () => exited.resolve());
    child.stdin.end();
    try {
      await withTimeout(exited.promise, 2_000, "OMP RPC did not exit cleanly.");
    } catch {
      child.kill();
    }
  }

  #consumeStdout(chunk) {
    this.#stdoutBuffer += chunk;
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > this.#maxFrameBytes * 2) {
      this.#protocolFailure(new Error("OMP RPC stdout exceeded the physical frame buffer limit."));
      return;
    }

    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line.trim()) {
        continue;
      }
      if (Buffer.byteLength(line, "utf8") > this.#maxFrameBytes) {
        this.#protocolFailure(new Error("OMP RPC emitted a frame larger than its advertised limit."));
        return;
      }
      try {
        this.#handlePhysicalFrame(JSON.parse(line));
      } catch (error) {
        this.#protocolFailure(error);
        return;
      }
    }
  }

  #handlePhysicalFrame(frame) {
    if (!frame || typeof frame !== "object") {
      throw new Error("OMP RPC emitted a non-object frame.");
    }
    if (frame.type === "rpc_chunk") {
      this.#consumeChunk(frame);
      return;
    }
    if (this.#chunk) {
      throw new Error("OMP RPC interrupted a chunk sequence with another frame.");
    }
    this.#handleFrame(frame);
  }

  #consumeChunk(frame) {
    if (
      typeof frame.chunkId !== "string" ||
      !Number.isInteger(frame.index) ||
      !Number.isInteger(frame.count) ||
      !Number.isInteger(frame.byteLength) ||
      typeof frame.data !== "string" ||
      frame.count < 1 ||
      frame.index < 0 ||
      frame.index >= frame.count ||
      frame.byteLength < 0 ||
      frame.byteLength > this.#maxReassembledBytes
    ) {
      throw new Error("OMP RPC emitted invalid chunk metadata.");
    }

    if (!this.#chunk) {
      if (frame.index !== 0) {
        throw new Error("OMP RPC chunk sequence did not begin at index zero.");
      }
      this.#chunk = {
        chunkId: frame.chunkId,
        count: frame.count,
        byteLength: frame.byteLength,
        buffers: [],
        bytes: 0,
      };
    }
    const active = this.#chunk;
    if (
      frame.chunkId !== active.chunkId ||
      frame.count !== active.count ||
      frame.byteLength !== active.byteLength ||
      frame.index !== active.buffers.length
    ) {
      throw new Error("OMP RPC emitted an interrupted or out-of-order chunk sequence.");
    }

    const buffer = Buffer.from(frame.data, "base64");
    active.buffers.push(buffer);
    active.bytes += buffer.length;
    if (active.bytes > active.byteLength || active.bytes > this.#maxReassembledBytes) {
      throw new Error("OMP RPC chunk sequence exceeded its declared size.");
    }
    if (active.buffers.length !== active.count) {
      return;
    }
    this.#chunk = null;
    if (active.bytes !== active.byteLength) {
      throw new Error("OMP RPC chunk sequence did not match its declared size.");
    }
    const bytes = Buffer.concat(active.buffers, active.bytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    this.#handleFrame(JSON.parse(text));
  }

  #handleFrame(frame) {
    if (frame.type === "ready") {
      this.#maxFrameBytes = frame.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES;
      this.#maxReassembledBytes = frame.maxReassembledFrameBytes || DEFAULT_MAX_REASSEMBLED_BYTES;
      this.#ready.resolve(frame);
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.#pending.get(frame.id);
      if (pending) {
        this.#pending.delete(frame.id);
        pending.resolve(frame);
      }
    }
    this.emit("frame", frame);
  }

  #protocolFailure(error) {
    this.emit("frame", { type: "protocol_error", error: error.message });
    this.#fail(error);
    this.#child?.kill();
  }

  #fail(error) {
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #handleExit(exitCode, signal) {
    const wasClosed = this.#closed;
    this.#closed = true;
    const error = new Error(
      signal ? `OMP RPC exited after signal ${signal}.` : `OMP RPC exited with code ${exitCode}.`,
    );
    if (!wasClosed && exitCode !== 0) {
      this.#fail(error);
    } else {
      for (const pending of this.#pending.values()) {
        pending.reject(error);
      }
      this.#pending.clear();
    }
    this.emit("exit", { exitCode, signal, expected: wasClosed });
  }
}

module.exports = {
  RpcProcess,
};
