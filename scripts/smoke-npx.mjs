import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempVault = process.env.OBSIDIAN_VAULT_PATH
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-reader-smoke-vault-"));
const vaultPath = process.env.OBSIDIAN_VAULT_PATH ?? tempVault;

if (tempVault) {
  fs.writeFileSync(path.join(tempVault, "Smoke.md"), "# Smoke\nhello mcp\n", "utf8");
}

const client = new Client({ name: "npx-smoke", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: "npx",
  args: [
    "--yes",
    `--package=${path.join(repoRoot, "obsidian-reader-mcp-0.1.1.tgz")}`,
    "--",
    "obsidian-reader-mcp",
    "--vault",
    vaultPath,
  ],
  cwd: repoRoot,
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(tools.tools.map((tool) => tool.name).sort().join(","));
} finally {
  await client.close();
  if (tempVault) fs.rmSync(tempVault, { recursive: true, force: true });
}
