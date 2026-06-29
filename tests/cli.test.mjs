import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repoRoot, "src", "cli.mjs");

function runCli(args, { env } = {}) {
    return execFileSync(process.execPath, [cliPath, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...env },
    });
}

test("--version prints the package version", () => {
    const out = runCli(["--version"]);
    assert.match(out.trim(), /^\d+\.\d+\.\d+/);
});

test("-v is an alias for --version", () => {
    const out = runCli(["-v"]);
    assert.match(out.trim(), /^\d+\.\d+\.\d+/);
});

test("--help prints usage with key options", () => {
    const out = runCli(["--help"]);
    assert.match(out, /obsidian-reader-mcp/);
    assert.match(out, /--vault/);
    assert.match(out, /--include-dot-obsidian/);
    assert.match(out, /--max-file-bytes/);
});

test("-h is an alias for --help", () => {
    const out = runCli(["-h"]);
    assert.match(out, /obsidian-reader-mcp/);
});

test("missing vault exits non-zero with a friendly hint", () => {
    // Run from an empty temp cwd with NO .env and no inherited vault env so the
    // vault truly is missing. repoRoot has its own .env which would otherwise
    // satisfy the lookup.
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-reader-cli-"));
    try {
        assert.throws(
            () =>
                execFileSync(process.execPath, [cliPath], {
                    cwd: emptyCwd,
                    encoding: "utf8",
                    env: { ...process.env, OBSIDIAN_VAULT_PATH: "" },
                }),
            (error) => {
                const stderr = (error && error.stderr) || String(error);
                assert.match(stderr, /OBSIDIAN_VAULT_PATH is required/);
                assert.match(stderr, /--vault/);
                return true;
            },
        );
    } finally {
        fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
});
