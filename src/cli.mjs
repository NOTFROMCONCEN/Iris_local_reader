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
function getLogPaths() {
  const paths = [
    process.env.OBSIDIAN_READER_LOG_PATH,
    path.join(process.cwd(), "logs", "kelivo-startup.log"),
    path.join(projectRoot, "logs", "kelivo-startup.log"),
  ].filter(Boolean);
  return [...new Set(paths.map((item) => path.resolve(item)))];
}

function logStartup(message, details = undefined) {
  const line = `[${new Date().toISOString()}] ${message}${details ? ` ${JSON.stringify(details)}` : ""}\n`;
  for (const logPath of getLogPaths()) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line, "utf8");
    } catch {
      // Never let diagnostics break stdio startup.
    }
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

applyCliArgs(process.argv.slice(2));

logStartup("starting", {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  cliDir,
  projectRoot,
  node: process.version,
  vault: process.env.OBSIDIAN_VAULT_PATH || null,
});

main().catch((error) => {
  logStartup("failed", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
