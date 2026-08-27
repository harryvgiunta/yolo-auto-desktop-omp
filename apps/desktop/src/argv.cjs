function parseCommandLine(value) {
  if (typeof value !== "string") {
    throw new TypeError("Launch arguments must be a string.");
  }

  const args = [];
  let token = "";
  let tokenStarted = false;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (quote) {
      if (character === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (character === "\\" && quote === '"') {
        const next = value[index + 1];
        if (next === '"' || next === "\\") {
          token += next;
          index += 1;
          tokenStarted = true;
          continue;
        }
      }
      token += character;
      tokenStarted = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) {
        args.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }

    if (character === "\\") {
      const next = value[index + 1];
      if (next && (/\s/u.test(next) || next === '"' || next === "'" || next === "\\")) {
        token += next;
        index += 1;
        tokenStarted = true;
        continue;
      }
    }

    token += character;
    tokenStarted = true;
  }

  if (quote) {
    throw new Error(`Unclosed ${quote} quote in launch arguments.`);
  }
  if (tokenStarted) {
    args.push(token);
  }
  return args;
}

module.exports = {
  parseCommandLine,
};
