#!/usr/bin/env node

import { main } from "./node-server.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findProjectRoot(startDir) {
  let current = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = findProjectRoot(cliDir);

function readPackageVersion() {
  // Best-effort version read. Falls back to "unknown" so --version never
  // crashes the CLI when package.json is unreachable (e.g. bundled contexts).
  try {
    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "unknown";
    }
  } catch {
    // ignore
  }
  return "unknown";
}

const PKG_VERSION = readPackageVersion();

const HELP_TEXT = `obsidian-reader-mcp v${PKG_VERSION}

Read-only MCP server for local Obsidian vaults.

Usage:
  obsidian-reader-mcp --vault <vault-path> [options]
  obsidian-reader-mcp --version
  obsidian-reader-mcp --help

Options:
  --vault, --vault-path <path>   Path to the Obsidian vault (required).
                                 Can also be set via OBSIDIAN_VAULT_PATH env
                                 or a .env file in the working directory.
  --include-dot-obsidian         Allow reading the .obsidian config folder.
  --max-file-bytes <n>           Max bytes per file read (default 1048576).
  --version                      Print version and exit.
  --help, -h                     Show this help and exit.

The server speaks MCP over stdio. It is normally launched by an MCP client
(Claude Desktop, Cursor, etc.) via npx, not run manually.`;

/**
 * Resolve a single authoritative startup log path.
 *
 * Previously this wrote to BOTH `cwd/logs` and `projectRoot/logs`, which meant
 * that two different processes (e.g. a client capability probe with a temp cwd
 * and the real npx launch with projectRoot == npx cache) could each write a
 * `starting` line into the same `projectRoot/logs` file, producing confusing
 * "duplicate startup" logs. We now pick exactly one location:
 *
 *   1. OBSIDIAN_READER_LOG_PATH (explicit override), else
 *   2. projectRoot/logs/kelivo-startup.log (stable regardless of cwd).
 *
 * Returns null if resolution fails so logging never breaks startup.
 */
function getLogPath() {
  const candidate = process.env.OBSIDIAN_READER_LOG_PATH
    || path.join(projectRoot, "logs", "kelivo-startup.log");
  try {
    return path.resolve(candidate);
  } catch {
    return null;
  }
}

function logStartup(message, details = undefined) {
  const logPath = getLogPath();
  if (!logPath) return;
  // Always tag the line with pid + a short launch-id so multi-process entries
  // (probe vs real launch) can be told apart in the same file.
  const payload = { pid: process.pid, ...(details || {}) };
  const line = `[${new Date().toISOString()}] ${message}${JSON.stringify(payload)}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // Never let diagnostics break stdio startup.
  }
}

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;

    const [rawKey, ...rawValueParts] = line.split("=");
    const key = rawKey.trim();
    if (!key || process.env[key] != null) continue;

    let value = rawValueParts.join("=").trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), ".env"));
loadDotEnv(path.resolve(projectRoot, ".env"));

function applyCliArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--vault" || arg === "--vault-path") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a path value.`);
      process.env.OBSIDIAN_VAULT_PATH = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--vault=") || arg.startsWith("--vault-path=")) {
      process.env.OBSIDIAN_VAULT_PATH = arg.slice(arg.indexOf("=") + 1);
      continue;
    }

    if (arg === "--include-dot-obsidian") {
      process.env.OBSIDIAN_READER_INCLUDE_DOT_OBSIDIAN = "true";
      continue;
    }

    if (arg === "--max-file-bytes") {
      const value = args[index + 1];
      if (!value) throw new Error("--max-file-bytes requires a numeric value.");
      process.env.OBSIDIAN_READER_MAX_FILE_BYTES = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--max-file-bytes=")) {
      process.env.OBSIDIAN_READER_MAX_FILE_BYTES = arg.slice(arg.indexOf("=") + 1);
    }
  }
}

const cliArgs = process.argv.slice(2);

// Handle --help / --version before anything else so users can verify an npx
// install succeeded without needing a configured vault.
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  process.stdout.write(`${HELP_TEXT}\n`);
  process.exit(0);
}
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  process.stdout.write(`${PKG_VERSION}\n`);
  process.exit(0);
}

applyCliArgs(cliArgs);

logStartup("starting", {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  cliDir,
  projectRoot,
  node: process.version,
  vault: process.env.OBSIDIAN_VAULT_PATH || null,
});

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logStartup("failed", {
    message,
    stack: error instanceof Error ? error.stack : null,
  });

  // Friendly guidance when the vault path is missing — the most common npx
  // startup failure for new users.
  if (message.includes("OBSIDIAN_VAULT_PATH is required")) {
    process.stderr.write(
      `${message}\n\nProvide the vault via one of:\n` +
      `  --vault <path>            e.g. obsidian-reader-mcp --vault "C:\\MyVault"\n` +
      `  OBSIDIAN_VAULT_PATH env   e.g. $env:OBSIDIAN_VAULT_PATH="C:\\MyVault"\n` +
      `  .env file                 OBSIDIAN_VAULT_PATH=... in the working dir\n`,
    );
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
});
