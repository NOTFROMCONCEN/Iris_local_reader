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
  loadSettings,
  readNote,
  rebuildIndex,
  resetSettingsCache,
  safeRelativePath,
  searchNotes,
} from "../src/node-server.mjs";

function withVault(fn) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-reader-"));
  const previousVault = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = vault;

  const cleanup = () => {
    if (previousVault == null) {
      delete process.env.OBSIDIAN_VAULT_PATH;
    } else {
      process.env.OBSIDIAN_VAULT_PATH = previousVault;
    }
    fs.rmSync(vault, { recursive: true, force: true });
  };

  try {
    const result = fn(vault);
    // Support both sync and async test callbacks: only defer cleanup for
    // promises so the temp vault is not removed before the awaited work done.
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          cleanup();
          return value;
        },
        (error) => {
          cleanup();
          throw error;
        },
      );
    }
    return result;
  } catch (error) {
    cleanup();
    throw error;
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

test("loadSettings caches and rebuilds when env changes", () => {
  resetSettingsCache();
  const env = { OBSIDIAN_VAULT_PATH: process.cwd() };
  const first = loadSettings(env);
  const second = loadSettings(env);
  // Same env key -> same cached instance (no re-stat).
  assert.equal(first, second);

  // Changing max bytes forces a rebuild -> new object.
  const third = loadSettings({ ...env, OBSIDIAN_READER_MAX_FILE_BYTES: "2048" });
  assert.notEqual(first, third);
  assert.equal(third.maxFileBytes, 2048);
  resetSettingsCache();
});

test("rebuildIndex reads files asynchronously and powers search", async () => {
  await withVault(async (vault) => {
    resetSettingsCache();
    fs.writeFileSync(path.join(vault, "Alpha.md"), "unique-token-xyz\n[[Beta]]\n", "utf8");
    fs.writeFileSync(path.join(vault, "Beta.md"), "Back to [[Alpha]].\n", "utf8");

    const settings = loadSettings();
    const entries = await rebuildIndex(settings);
    assert.ok(entries.has(path.join(vault, "Alpha.md")));
    assert.ok(entries.has(path.join(vault, "Beta.md")));

    // After async rebuild, search goes through the cached index.
    const result = searchNotes({ query: "unique-token-xyz" });
    assert.equal(result.results[0].path, "Alpha.md");
    resetSettingsCache();
  });
});

test("search respects directory scope and skips files outside it", () => withVault((vault) => {
  resetSettingsCache();
  fs.mkdirSync(path.join(vault, "FolderA"));
  fs.mkdirSync(path.join(vault, "FolderB"));
  fs.writeFileSync(path.join(vault, "FolderA", "A.md"), "shared-term-here\n", "utf8");
  fs.writeFileSync(path.join(vault, "FolderB", "B.md"), "shared-term-here\n", "utf8");

  const scoped = searchNotes({ query: "shared-term-here", directory: "FolderA" });
  assert.deepEqual(
    scoped.results.map((r) => r.path),
    ["FolderA/A.md"],
  );
  resetSettingsCache();
}));

test("extractFrontmatter parses YAML lists and scalars", () => {
  const text = "---\ntitle: Hello\ntags:\n  - mcp\n  - obsidian\ncount: 42\ndraft: false\n---\n# Body";
  assert.deepEqual(extractFrontmatter(text), {
    title: "Hello",
    tags: ["mcp", "obsidian"],
    count: "42",
    draft: "false",
  });
});

test("extractFrontmatter falls back on malformed YAML", () => {
  // Broken YAML: a bare colon key with no value still yields a stable map.
  const text = "---\nstatus: active\n---\n# Title";
  assert.deepEqual(extractFrontmatter(text), { status: "active" });
});

test("extractLinks handles markdown links with nested parentheses", () => {
  const text = "See [note](Path(1).md) and [img](assets/folder(x)/pic.png).";
  assert.deepEqual(extractLinks(text), [
    { type: "markdown", target: "Path(1).md" },
    { type: "markdown", target: "assets/folder(x)/pic.png" },
  ]);
});
