const assert = require("node:assert/strict");
const path = require("node:path");
const pty = require("node-pty");
const manifest = require("../runtime-manifest.json");
const { resolveRuntime } = require("../src/runtime.cjs");

async function main() {
  const desktopDirectory = path.resolve(__dirname, "..");
  const runtime = resolveRuntime({
    desktopDirectory,
    isPackaged: false,
  });

  assert.equal(runtime.available, true, runtime.message);

  let output = "";
  const terminal = pty.spawn(runtime.command, [...runtime.args, "--version"], {
    name: "xterm-256color",
    cols: 100,
    rows: 24,
    cwd: desktopDirectory,
    env: {
      ...process.env,
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    },
  });
  terminal.onData((data) => {
    output += data;
  });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error("OMP did not answer --version through the desktop PTY within 20 seconds."));
    }, 20_000);
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal });
    });
  });

  const plainOutput = output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
  assert.ok(
    result.signal === undefined || result.signal === 0,
    `OMP exited from signal ${result.signal}: ${plainOutput}`,
  );
  assert.equal(result.exitCode, 0, plainOutput);
  assert.match(plainOutput, new RegExp(`\\b${manifest.version.replaceAll(".", "\\.")}\\b`, "u"));
  console.log(`Desktop PTY launched OMP ${manifest.version} successfully.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
