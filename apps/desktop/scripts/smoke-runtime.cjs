const assert = require("node:assert/strict");
const path = require("node:path");
const manifest = require("../runtime-manifest.json");
const { RpcProcess } = require("../src/rpc-session.cjs");
const { resolveRuntime } = require("../src/runtime.cjs");

async function main() {
  const desktopDirectory = path.resolve(__dirname, "..");
  const runtime = resolveRuntime({ desktopDirectory, isPackaged: false });
  assert.equal(runtime.available, true, runtime.message);

  const rpc = new RpcProcess({
    command: runtime.command,
    args: [...runtime.args, "--mode", "rpc"],
    cwd: desktopDirectory,
    env: { ...process.env, PWD: desktopDirectory, TERM: "dumb" },
  });
  const ready = await rpc.start();
  assert.equal(ready.type, "ready");
  assert.ok(ready.supportedProtocolVersions.includes(2));

  const state = await rpc.request({ type: "get_state" });
  assert.equal(state.success, true, state.error);
  assert.equal(typeof state.data.sessionId, "string");
  assert.equal(typeof state.data.isStreaming, "boolean");

  const commands = await rpc.request({ type: "get_available_commands" });
  assert.equal(commands.success, true, commands.error);
  const modelCommand = commands.data.commands.find((command) => command.name === "model");
  assert.equal(typeof modelCommand?.description, "string");

  await rpc.stop();
  console.log(`Desktop RPC connected to OMP ${manifest.version} and loaded slash commands successfully.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
