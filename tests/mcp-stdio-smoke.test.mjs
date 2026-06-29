import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("stdio client can initialize server using cwd .env", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-reader-cwd-"));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-reader-vault-"));
  fs.writeFileSync(path.join(vault, "Note.md"), "# Note\nhello mcp\n", "utf8");
  fs.writeFileSync(path.join(cwd, ".env"), `OBSIDIAN_VAULT_PATH=${vault}\n`, "utf8");

  const client = new Client({ name: "obsidian-reader-smoke", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "src", "cli.mjs")],
    cwd,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["find_backlinks", "get_note_metadata", "list_notes", "read_note", "search_notes"],
    );
  } finally {
    await client.close();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
