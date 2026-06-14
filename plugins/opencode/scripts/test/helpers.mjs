import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Creates an isolated workspace + plugin-data dir so state lands in a temp
// location instead of the developer's real ~/.claude data. Returns the
// workspace root to pass as `cwd` to state/job functions, plus a cleanup fn.
export function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"));
  const workspace = path.join(root, "workspace");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(pluginData, { recursive: true });

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;

  return {
    workspace,
    pluginData,
    cleanup() {
      if (previous === undefined) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previous;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
