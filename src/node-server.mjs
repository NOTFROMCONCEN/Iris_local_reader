#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
const MARKDOWN_LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

function parseBool(value, defaultValue = false) {
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

export function loadSettings(env = process.env) {
  const rawVault = env.OBSIDIAN_VAULT_PATH;
  if (!rawVault) {
    throw new Error("OBSIDIAN_VAULT_PATH is required.");
  }

  const vaultPath = path.resolve(rawVault);
  const stat = fs.existsSync(vaultPath) ? fs.statSync(vaultPath) : null;
  if (!stat?.isDirectory()) {
    throw new Error(`OBSIDIAN_VAULT_PATH is not a directory: ${vaultPath}`);
  }

  return {
    vaultPath,
    includeDotObsidian: parseBool(env.OBSIDIAN_READER_INCLUDE_DOT_OBSIDIAN),
    maxFileBytes: Number.parseInt(env.OBSIDIAN_READER_MAX_FILE_BYTES ?? "1048576", 10),
  };
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

export function extractFrontmatter(text) {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return {};

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
    const stat = fs.statSync(childPath);
    entries.push({
      path: relativePath(settings, childPath),
      name: child.name,
      type: child.isDirectory() ? "directory" : "file",
      size: child.isFile() ? stat.size : null,
      modified: stat.mtime.toISOString().slice(0, 19),
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

export function searchNotes({ query, directory = "", limit = 50 } = {}) {
  if (!String(query ?? "").trim()) throw new Error("query is required.");

  const settings = loadSettings();
  const root = safeRelativePath(settings, directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("directory must point to an existing folder.");
  }

  const max = Math.max(1, Math.min(limit, 200));
  const results = [];
  for (const targetPath of walkTextFiles(settings, root)) {
    let text = "";
    try {
      text = readText(settings, targetPath);
    } catch {
      continue;
    }

    if (!text.toLowerCase().includes(String(query).toLowerCase())) continue;
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

export function findBacklinks({ target, limit = 100 } = {}) {
  const settings = loadSettings();
  const candidates = new Set([...noteIdCandidates(settings, target)].map((value) => value.toLowerCase()));
  const max = Math.max(1, Math.min(limit, 500));
  const backlinks = [];

  for (const targetPath of walkTextFiles(settings)) {
    let text = "";
    try {
      text = readText(settings, targetPath);
    } catch {
      continue;
    }

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
    version: "0.1.0",
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
  loadSettings();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
