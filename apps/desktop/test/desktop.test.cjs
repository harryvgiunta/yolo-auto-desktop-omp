const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parseCommandLine } = require("../src/argv.cjs");
const { findExecutable, resolveRuntime } = require("../src/runtime.cjs");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omp-desktop-test-"));
}

test("launch arguments preserve quoted values, empty values, and Windows paths", () => {
  assert.deepEqual(
    parseCommandLine('--model "openai/gpt 5" --name \'desktop run\' --empty "" C:\\work\\repo'),
    ["--model", "openai/gpt 5", "--name", "desktop run", "--empty", "", "C:\\work\\repo"],
  );
});

test("launch arguments reject an unterminated quote before process creation", () => {
  assert.throws(() => parseCommandLine('--model "broken'), /Unclosed " quote/u);
});

test("executable discovery respects the supplied PATH", (context) => {
  const directory = temporaryDirectory();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, process.platform === "win32" ? "omp.exe" : "omp");
  fs.writeFileSync(executable, "test");

  assert.equal(
    findExecutable("omp", {
      platform: process.platform,
      pathValue: directory,
      pathExtensions: ".EXE",
    }),
    executable,
  );
});

test("custom OMP runtime takes precedence over bundled and system runtimes", (context) => {
  const directory = temporaryDirectory();
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, process.platform === "win32" ? "custom-omp.exe" : "custom-omp");
  fs.writeFileSync(runtime, "test");

  const result = resolveRuntime({
    platform: process.platform,
    architecture: process.arch,
    desktopDirectory: directory,
    isPackaged: false,
    environment: {
      OMP_DESKTOP_RUNTIME: runtime,
      PATH: "",
      PATHEXT: ".EXE",
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.command, runtime);
  assert.equal(result.mode, "custom");
});
