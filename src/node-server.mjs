#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import YAML from "yaml";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".canvas",
  ".json",
  ".csv",
  ".yaml",
  ".yml",
]);

const WIKILINK_RE = /!\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]/g;
// Match markdown links `[text](target)`. The target group allows one level of
// nested parentheses, e.g. `[x](path(1).md)`, which the old `[^)]+` pattern
// truncated at the first `)`. Inner chars use `[^()]` (not `[^)]`) so the
// outer closing paren is unambiguous.
const MARKDOWN_LINK_RE = /!?\[[^\]]*\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

function parseBool(value, defaultValue = false) {
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

/**
 * Cached settings. The vault path / env knobs rarely change during a process
 * lifetime, so we compute them once and reuse across every tool call instead
 * of re-stat-ing the vault directory on each invocation.
 */
let cachedSettings = null;
let cachedSettingsKey = "";

function settingsCacheKey(env = process.env) {
  return [
    env.OBSIDIAN_VAULT_PATH ?? "",
    env.OBSIDIAN_READER_INCLUDE_DOT_OBSIDIAN ?? "",
    env.OBSIDIAN_READER_MAX_FILE_BYTES ?? "",
  ].join("\u0000");
}

export function loadSettings(env = process.env, { force = false } = {}) {
  const key = settingsCacheKey(env);
  if (!force && cachedSettings && cachedSettingsKey === key) return cachedSettings;

  const rawVault = env.OBSIDIAN_VAULT_PATH;
  if (!rawVault) {
    throw new Error("OBSIDIAN_VAULT_PATH is required.");
  }

  const vaultPath = path.resolve(rawVault);
  const stat = fs.existsSync(vaultPath) ? fs.statSync(vaultPath) : null;
  if (!stat?.isDirectory()) {
    throw new Error(`OBSIDIAN_VAULT_PATH is not a directory: ${vaultPath}`);
  }

  cachedSettings = {
    vaultPath,
    includeDotObsidian: parseBool(env.OBSIDIAN_READER_INCLUDE_DOT_OBSIDIAN),
    maxFileBytes: Number.parseInt(env.OBSIDIAN_READER_MAX_FILE_BYTES ?? "1048576", 10),
  };
  cachedSettingsKey = key;
  return cachedSettings;
}

/**
 * Reset the settings cache. Exposed primarily for tests so they can swap the
 * vault path between cases without leaking the previous process settings.
 */
export function resetSettingsCache() {
  cachedSettings = null;
  cachedSettingsKey = "";
}

export function safeRelativePath(settings, relativePath = "") {
  const cleanPath = String(relativePath ?? "").trim().replace(/^["']|["']$/g, "");
  const candidate = path.resolve(settings.vaultPath, cleanPath);
  const relative = path.relative(settings.vaultPath, candidate);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the configured Obsidian vault.");
  }

  if (!settings.includeDotObsidian) {
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.includes(".obsidian")) {
      throw new Error("Reading .obsidian is disabled by default.");
    }
  }

  return candidate;
}

function relativePath(settings, targetPath) {
  return path.relative(settings.vaultPath, targetPath).replaceAll(path.sep, "/");
}

function isVisible(settings, targetPath) {
  if (settings.includeDotObsidian) return true;
  const relative = path.relative(settings.vaultPath, targetPath);
  return !relative.split(path.sep).includes(".obsidian");
}

function isReadableText(targetPath) {
  return fs.statSync(targetPath).isFile() && TEXT_EXTENSIONS.has(path.extname(targetPath).toLowerCase());
}

function readText(settings, targetPath) {
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    throw new Error(`File does not exist: ${relativePath(settings, targetPath)}`);
  }
  if (!isReadableText(targetPath)) {
    throw new Error(`Unsupported text file extension: ${path.extname(targetPath)}`);
  }

  const size = fs.statSync(targetPath).size;
  if (size > settings.maxFileBytes) {
    throw new Error(`File is larger than OBSIDIAN_READER_MAX_FILE_BYTES: ${size} bytes`);
  }

  return fs.readFileSync(targetPath, "utf8").replace(/^\uFEFF/, "");
}

/**
 * In-memory index: maps absolute file path -> file text content.
 *
 * `search_notes` and `find_backlinks` previously walked the whole vault and
 * read every file from disk on EACH call. With a few hundred notes that is
 * already sluggish; with thousands it blocks the MCP transport for seconds.
 *
 * We build the index once at startup (async, see `rebuildIndex`) and reuse it
 * for subsequent queries. The index is keyed by vault path so swapping vaults
 * (e.g. in tests) does not return stale entries.
 */
const indexByVault = new Map();

function* walkTextFiles(settings, root = settings.vaultPath) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (!isVisible(settings, fullPath)) continue;
    if (entry.isDirectory()) {
      yield* walkTextFiles(settings, fullPath);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield fullPath;
    }
  }
}

/** Async directory walk used when (re)building the index without blocking. */
async function* walkTextFilesAsync(settings, root = settings.vaultPath) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (!isVisible(settings, fullPath)) continue;
    if (entry.isDirectory()) {
      yield* walkTextFilesAsync(settings, fullPath);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield fullPath;
    }
  }
}

/**
 * Build (or rebuild) the text index for the given settings using async I/O so
 * the MCP event loop stays responsive while the vault is being scanned.
 *
 * Files that fail to read (encoding, oversized, etc.) are skipped silently —
 * they are also skipped by the tool implementations, so this stays consistent.
 */
export async function rebuildIndex(settings = loadSettings()) {
  const entries = new Map();
  for await (const targetPath of walkTextFilesAsync(settings)) {
    try {
      const stat = await fsp.stat(targetPath);
      if (stat.size > settings.maxFileBytes) continue;
      const raw = await fsp.readFile(targetPath, "utf8");
      entries.set(targetPath, raw.replace(/^\uFEFF/, ""));
    } catch {
      // Skip unreadable files — same behavior as the per-call readers.
    }
  }
  indexByVault.set(settings.vaultPath, entries);
  return entries;
}

/**
 * Return the cached index for the active vault, lazily building it on first
 * access (synchronous fallback for tests / direct tool calls that bypass
 * `main()`). Hot-path callers should prefer `rebuildIndex()` at startup.
 */
function getIndex(settings) {
  let entries = indexByVault.get(settings.vaultPath);
  if (entries) return entries;
  // Synchronous lazy build so direct calls (tests, ad-hoc CLI use) still work.
  entries = new Map();
  for (const targetPath of walkTextFiles(settings)) {
    try {
      entries.set(targetPath, readText(settings, targetPath));
    } catch {
      // Skip unreadable files — same behavior as the per-call readers.
    }
  }
  indexByVault.set(settings.vaultPath, entries);
  return entries;
}

/**
 * Parse YAML frontmatter.
 *
 * Uses the `yaml` package so lists, multi-line strings, quotes and nested
 * mappings are handled correctly (the old line-split parser only supported
 * flat `key: value`). If YAML parsing fails for any reason we fall back to a
 * best-effort flat string map so a malformed block never breaks the tool.
 *
 * Values are normalized to JSON-serializable scalars/arrays: non-string YAML
 * scalars (numbers, booleans, dates) are stringified to keep the tool output
 * stable and consistent with the previous string-only contract.
 */
function toStableFrontmatter(raw) {
  const metadata = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) {
      metadata[key] = "";
    } else if (Array.isArray(value)) {
      metadata[key] = value.map((item) => (typeof item === "string" ? item : String(item)));
    } else if (typeof value === "object") {
      // Nested mappings/objects: stringify to keep the flat contract stable.
      try {
        metadata[key] = JSON.stringify(value);
      } catch {
        metadata[key] = String(value);
      }
    } else {
      metadata[key] = typeof value === "string" ? value : String(value);
    }
  }
  return metadata;
}

export function extractFrontmatter(text) {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return {};

  try {
    const parsed = YAML.parse(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return toStableFrontmatter(parsed);
    }
  } catch {
    // Fall through to best-effort line parsing below.
  }

  // Best-effort fallback: flat `key: value` only.
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.includes(":") || line.trimStart().startsWith("#")) continue;
    const [key, ...rest] = line.split(":");
    metadata[key.trim()] = rest.join(":").trim();
  }
  return metadata;
}

export function extractLinks(text) {
  const links = [];
  for (const match of text.matchAll(WIKILINK_RE)) {
    const rawTarget = match[1] || match[2] || "";
    const target = rawTarget.split("|", 1)[0].split("#", 1)[0].trim();
    if (target) links.push({ type: "wikilink", target });
  }

  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const target = match[1].trim();
    if (target && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
      links.push({ type: "markdown", target });
    }
  }
  return links;
}

function noteIdCandidates(settings, target) {
  const targetPath = safeRelativePath(settings, target);
  const relative = relativePath(settings, targetPath);
  const parsed = path.parse(relative);
  const noSuffix = path.join(parsed.dir, parsed.name).replaceAll(path.sep, "/");
  return new Set([String(target).trim(), relative, noSuffix, parsed.name].filter(Boolean));
}

function lineContext(text, needle, contextChars = 120) {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return "";
  const start = Math.max(0, index - contextChars);
  const end = Math.min(text.length, index + needle.length + contextChars);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function asToolText(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function listNotes({ directory = "", limit = 200 } = {}) {
  const settings = loadSettings();
  const root = safeRelativePath(settings, directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("directory must point to an existing folder.");
  }

  const max = Math.max(1, Math.min(limit, 1000));
  const entries = [];
  const children = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => {
    if (a.isFile() !== b.isFile()) return a.isFile() ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  for (const child of children) {
    const childPath = path.join(root, child.name);
    if (!isVisible(settings, childPath)) continue;
    // `child.isFile()` is already known from the dirent; stat once for size.
    const stat = child.isFile() ? fs.statSync(childPath) : null;
    entries.push({
      path: relativePath(settings, childPath),
      name: child.name,
      type: child.isDirectory() ? "directory" : "file",
      size: child.isFile() ? stat.size : null,
      modified: stat ? stat.mtime.toISOString().slice(0, 19) : null,
    });
    if (entries.length >= max) break;
  }

  return { vault: settings.vaultPath, directory, entries };
}

export function readNote({ filePath, path: notePath, maxChars = 40000 } = {}) {
  const settings = loadSettings();
  const resolvedPath = safeRelativePath(settings, filePath ?? notePath);
  const text = readText(settings, resolvedPath);
  const max = Math.max(100, Math.min(maxChars, 200000));
  return {
    path: relativePath(settings, resolvedPath),
    content: text.slice(0, max),
    truncated: text.length > max,
    characters: text.length,
  };
}

/**
 * Search notes using the in-memory index instead of re-reading every file
 * from disk on each call. Falls back gracefully if the index is empty.
 */
export function searchNotes({ query, directory = "", limit = 50 } = {}) {
  if (!String(query ?? "").trim()) throw new Error("query is required.");

  const settings = loadSettings();
  const root = safeRelativePath(settings, directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("directory must point to an existing folder.");
  }

  const max = Math.max(1, Math.min(limit, 200));
  const index = getIndex(settings);
  const needle = String(query).toLowerCase();
  const results = [];

  for (const [targetPath, text] of index) {
    // Restrict to the requested sub-directory.
    const rel = path.relative(root, targetPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;

    if (!text.toLowerCase().includes(needle)) continue;
    results.push({
      path: relativePath(settings, targetPath),
      title: path.parse(targetPath).name,
      context: lineContext(text, String(query)),
    });
    if (results.length >= max) break;
  }

  return { query, results };
}

export function getNoteMetadata({ filePath, path: notePath } = {}) {
  const settings = loadSettings();
  const resolvedPath = safeRelativePath(settings, filePath ?? notePath);
  const text = readText(settings, resolvedPath);
  const headings = [...text.matchAll(HEADING_RE)].map((match) => ({
    level: match[1].length,
    text: match[2].trim(),
  }));
  const stat = fs.statSync(resolvedPath);

  return {
    path: relativePath(settings, resolvedPath),
    title: headings[0]?.text ?? path.parse(resolvedPath).name,
    size: stat.size,
    modified: stat.mtime.toISOString().slice(0, 19),
    frontmatter: extractFrontmatter(text),
    headings,
    links: extractLinks(text),
  };
}

/**
 * Find backlinks using the in-memory index. Previously this read every file
 * in the vault on each call; now it scans cached text only.
 */
export function findBacklinks({ target, limit = 100 } = {}) {
  const settings = loadSettings();
  const candidates = new Set([...noteIdCandidates(settings, target)].map((value) => value.toLowerCase()));
  const max = Math.max(1, Math.min(limit, 500));
  const index = getIndex(settings);
  const backlinks = [];

  for (const [targetPath, text] of index) {
    const matchedLinks = extractLinks(text).filter((link) => candidates.has(link.target.trim().toLowerCase()));
    if (!matchedLinks.length) continue;

    backlinks.push({
      path: relativePath(settings, targetPath),
      title: path.parse(targetPath).name,
      links: matchedLinks,
    });
    if (backlinks.length >= max) break;
  }

  return { target, backlinks };
}

export function createServer() {
  const server = new McpServer({
    name: "obsidian-reader",
    version: "0.1.1",
  });

  server.tool(
    "list_notes",
    "List files and directories inside the configured Obsidian vault.",
    {
      directory: z.string().optional().default(""),
      limit: z.number().int().min(1).max(1000).optional().default(200),
    },
    async (args) => asToolText(listNotes(args)),
  );

  server.tool(
    "read_note",
    "Read a Markdown, Canvas, JSON, YAML, CSV, or text file from the vault.",
    {
      path: z.string(),
      maxChars: z.number().int().min(100).max(200000).optional().default(40000),
    },
    async (args) => asToolText(readNote(args)),
  );

  server.tool(
    "search_notes",
    "Search text files in the vault for a case-insensitive query.",
    {
      query: z.string(),
      directory: z.string().optional().default(""),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async (args) => asToolText(searchNotes(args)),
  );

  server.tool(
    "get_note_metadata",
    "Extract lightweight metadata from one note.",
    {
      path: z.string(),
    },
    async (args) => asToolText(getNoteMetadata(args)),
  );

  server.tool(
    "find_backlinks",
    "Find notes that link to a target note path or title.",
    {
      target: z.string(),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
    async (args) => asToolText(findBacklinks(args)),
  );

  return server;
}

export async function main() {
  const settings = loadSettings();
  // Pre-build the text index asynchronously so the first search / backlink
  // query is fast and the MCP event loop is not blocked during startup.
  await rebuildIndex(settings);
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
