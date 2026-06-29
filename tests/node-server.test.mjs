import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractFrontmatter,
  extractLinks,
  findBacklinks,
  getNoteMetadata,
  listNotes,
  readNote,
  safeRelativePath,
  searchNotes,
} from "../src/node-server.mjs";

function withVault(fn) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-reader-"));
  const previousVault = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = vault;

  try {
    return fn(vault);
  } finally {
    if (previousVault == null) {
      delete process.env.OBSIDIAN_VAULT_PATH;
    } else {
      process.env.OBSIDIAN_VAULT_PATH = previousVault;
    }
    fs.rmSync(vault, { recursive: true, force: true });
  }
}

test("safeRelativePath rejects path escape and dot obsidian", () => {
  const settings = {
    vaultPath: path.resolve("vault"),
    includeDotObsidian: false,
    maxFileBytes: 1024,
  };

  assert.throws(() => safeRelativePath(settings, "../outside.md"), /escapes/);
  assert.throws(() => safeRelativePath(settings, ".obsidian/app.json"), /.obsidian/);
});

test("extractLinks supports wikilinks and markdown links", () => {
  const text = "See [[Folder/Note#Heading|alias]], ![[Image.png]], and [local](Other.md).";
  assert.deepEqual(extractLinks(text), [
    { type: "wikilink", target: "Folder/Note" },
    { type: "wikilink", target: "Image.png" },
    { type: "markdown", target: "Other.md" },
  ]);
});

test("extractFrontmatter reads simple keys", () => {
  const text = "---\ntags: mcp, obsidian\nstatus: draft\n---\n# Title";
  assert.deepEqual(extractFrontmatter(text), { tags: "mcp, obsidian", status: "draft" });
});

test("tools read search metadata and backlinks", () => withVault((vault) => {
  fs.mkdirSync(path.join(vault, "Inbox"));
  fs.writeFileSync(
    path.join(vault, "Inbox", "Project.md"),
    "---\nstatus: active\n---\n# Project\nMCP search target\n[[Reference]]\n",
    "utf8",
  );
  fs.writeFileSync(path.join(vault, "Reference.md"), "# Reference\nBack to [[Project]].\n", "utf8");
  fs.mkdirSync(path.join(vault, ".obsidian"));
  fs.writeFileSync(path.join(vault, ".obsidian", "app.json"), "{}", "utf8");

  assert.deepEqual(listNotes().entries.map((entry) => entry.path), ["Inbox", "Reference.md"]);
  assert.match(readNote({ path: "Inbox/Project.md" }).content, /MCP search target/);
  assert.equal(searchNotes({ query: "search target" }).results[0].path, "Inbox/Project.md");
  assert.deepEqual(getNoteMetadata({ path: "Inbox/Project.md" }).frontmatter, { status: "active" });
  assert.equal(findBacklinks({ target: "Inbox/Project.md" }).backlinks[0].path, "Reference.md");
}));
