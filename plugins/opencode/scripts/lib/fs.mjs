import fs from "node:fs";

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function tailFile(filePath, maxBytes = 8192) {
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(filePath, "utf8");
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
    const text = buffer.toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// A fixed-size rolling tail: appends text but retains only the last
// `maxLength` characters, so accumulating the output of an unbounded process
// stream cannot grow memory without limit.
export function createTailBuffer(maxLength = 65536) {
  let value = "";
  return {
    push(text) {
      value += text;
      // Trim lazily: let the buffer grow to 2× before slicing so push stays
      // amortized O(1) instead of re-copying ~maxLength chars on every chunk.
      if (value.length > maxLength * 2) {
        value = value.slice(value.length - maxLength);
      }
    },
    value() {
      return value.length > maxLength ? value.slice(value.length - maxLength) : value;
    }
  };
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
