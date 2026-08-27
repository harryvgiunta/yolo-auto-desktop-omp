const fs = require("node:fs");
const path = require("node:path");

const manifest = require("../runtime-manifest.json");

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function executableNames(command, platform, pathExtensions) {
  if (platform !== "win32" || path.extname(command)) {
    return [command];
  }
  const extensions = (pathExtensions || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function findExecutable(command, options = {}) {
  const platform = options.platform || process.platform;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const pathExtensions = options.pathExtensions ?? process.env.PATHEXT;
  const names = executableNames(command, platform, pathExtensions);

  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return names.find(isFile) || null;
  }

  for (const directory of pathValue.split(path.delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, "");
    for (const name of names) {
      const candidate = path.join(cleanDirectory, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveRuntime(options = {}) {
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const desktopDirectory = options.desktopDirectory || path.resolve(__dirname, "..");
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const isPackaged = options.isPackaged ?? false;
  const environment = options.environment || process.env;
  const targetKey = `${platform}-${architecture}`;
  const target = manifest.targets[targetKey];

  if (!target) {
    return {
      available: false,
      targetKey,
      message: `Unsupported platform: ${targetKey}`,
    };
  }

  if (environment.OMP_DESKTOP_RUNTIME) {
    const customRuntime = path.resolve(environment.OMP_DESKTOP_RUNTIME);
    if (isFile(customRuntime)) {
      return {
        available: true,
        command: customRuntime,
        args: [],
        label: "Custom OMP runtime",
        mode: "custom",
        targetKey,
        version: null,
      };
    }
  }

  const bundledRuntime = isPackaged
    ? path.join(resourcesPath, "runtime", targetKey, target.asset)
    : path.join(desktopDirectory, "runtime", targetKey, target.asset);
  if (isFile(bundledRuntime)) {
    return {
      available: true,
      command: bundledRuntime,
      args: [],
      label: `Bundled OMP ${manifest.version}`,
      mode: "bundled",
      targetKey,
      version: manifest.version,
    };
  }

  const systemRuntime = findExecutable("omp", {
    platform,
    pathValue: environment.PATH,
    pathExtensions: environment.PATHEXT,
  });
  if (systemRuntime) {
    return {
      available: true,
      command: systemRuntime,
      args: [],
      label: "System OMP",
      mode: "system",
      targetKey,
      version: null,
    };
  }

  if (!isPackaged) {
    const bunRuntime = findExecutable("bun", {
      platform,
      pathValue: environment.PATH,
      pathExtensions: environment.PATHEXT,
    });
    const sourceEntry = path.resolve(desktopDirectory, "../..", "packages/coding-agent/src/cli.ts");
    if (bunRuntime && isFile(sourceEntry)) {
      return {
        available: true,
        command: bunRuntime,
        args: [sourceEntry],
        label: "OMP source checkout",
        mode: "source",
        targetKey,
        version: null,
      };
    }
  }

  return {
    available: false,
    targetKey,
    message: "OMP runtime is missing. Run npm run runtime:prepare in apps/desktop.",
  };
}

module.exports = {
  findExecutable,
  resolveRuntime,
};
