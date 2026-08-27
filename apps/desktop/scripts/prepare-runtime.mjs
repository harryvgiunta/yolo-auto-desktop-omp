import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const manifest = JSON.parse(
  await fs.readFile(path.join(desktopDirectory, "runtime-manifest.json"), "utf8"),
);

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

const platform = option("platform", process.platform);
const architecture = option("arch", process.arch);
const targetKey = `${platform}-${architecture}`;
const target = manifest.targets[targetKey];

if (!target) {
  throw new Error(
    `OMP does not publish a desktop runtime for ${targetKey}. Supported targets: ${Object.keys(manifest.targets).join(", ")}`,
  );
}

const targetDirectory = path.join(desktopDirectory, "runtime", targetKey);
const targetPath = path.join(targetDirectory, target.asset);
await fs.mkdir(targetDirectory, { recursive: true });

try {
  if ((await sha256(targetPath)) === target.sha256) {
    console.log(`OMP ${manifest.version} runtime is ready: ${targetPath}`);
    process.exit(0);
  }
  await fs.rm(targetPath, { force: true });
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

const downloadUrl = `https://github.com/${manifest.repository}/releases/download/v${manifest.version}/${target.asset}`;
const temporaryPath = `${targetPath}.download`;
await fs.rm(temporaryPath, { force: true });
console.log(`Downloading OMP ${manifest.version} for ${targetKey}...`);

const response = await fetch(downloadUrl, { redirect: "follow" });
if (!response.ok || !response.body) {
  throw new Error(`Failed to download ${downloadUrl}: HTTP ${response.status}`);
}

const hash = createHash("sha256");
const hashingStream = new Transform({
  transform(chunk, _encoding, callback) {
    hash.update(chunk);
    callback(null, chunk);
  },
});

try {
  await pipeline(
    Readable.fromWeb(response.body),
    hashingStream,
    createWriteStream(temporaryPath, { flags: "wx" }),
  );
  const digest = hash.digest("hex");
  if (digest !== target.sha256) {
    throw new Error(`OMP runtime checksum mismatch: expected ${target.sha256}, received ${digest}`);
  }
  await fs.rename(temporaryPath, targetPath);
  if (platform !== "win32") {
    await fs.chmod(targetPath, 0o755);
  }
} catch (error) {
  await fs.rm(temporaryPath, { force: true });
  throw error;
}

console.log(`OMP ${manifest.version} runtime is ready: ${targetPath}`);
