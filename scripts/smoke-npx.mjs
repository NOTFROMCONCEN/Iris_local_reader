import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const client = new Client({ name: "npx-smoke", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: "npx",
  args: [
    "--yes",
    `--package=${path.join(repoRoot, "obsidian-reader-mcp-0.1.1.tgz")}`,
    "--",
    "obsidian-reader-mcp",
    "--vault",
    process.env.OBSIDIAN_VAULT_PATH ?? "F:\\缓存\\obsidian_datasql\\obsidian_datasql",
  ],
  cwd: repoRoot,
  stderr: "pipe",
});

await client.connect(transport);
const tools = await client.listTools();
console.log(tools.tools.map((tool) => tool.name).sort().join(","));
await client.close();
