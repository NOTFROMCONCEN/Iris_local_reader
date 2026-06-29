from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


TEXT_EXTENSIONS = {
    ".md",
    ".markdown",
    ".txt",
    ".canvas",
    ".json",
    ".csv",
    ".yaml",
    ".yml",
}

WIKILINK_RE = re.compile(r"!\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]")
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.DOTALL)


@dataclass(frozen=True)
class Settings:
    vault_path: Path
    include_dot_obsidian: bool
    max_file_bytes: int


def _parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def load_settings() -> Settings:
    raw_vault = os.environ.get("OBSIDIAN_VAULT_PATH")
    if not raw_vault:
        raise RuntimeError("OBSIDIAN_VAULT_PATH is required.")

    vault_path = Path(raw_vault).expanduser().resolve()
    if not vault_path.exists() or not vault_path.is_dir():
        raise RuntimeError(f"OBSIDIAN_VAULT_PATH is not a directory: {vault_path}")

    max_file_bytes = int(os.environ.get("OBSIDIAN_READER_MAX_FILE_BYTES", "1048576"))
    return Settings(
        vault_path=vault_path,
        include_dot_obsidian=_parse_bool(os.environ.get("OBSIDIAN_READER_INCLUDE_DOT_OBSIDIAN")),
        max_file_bytes=max_file_bytes,
    )


def _safe_relative_path(settings: Settings, relative_path: str | None = "") -> Path:
    clean_path = (relative_path or "").strip().strip("\"'")
    candidate = (settings.vault_path / clean_path).resolve()

    if candidate != settings.vault_path and settings.vault_path not in candidate.parents:
        raise ValueError("Path escapes the configured Obsidian vault.")

    if not settings.include_dot_obsidian:
        rel_parts = candidate.relative_to(settings.vault_path).parts
        if ".obsidian" in rel_parts:
            raise ValueError("Reading .obsidian is disabled by default.")

    return candidate


def _relative(settings: Settings, path: Path) -> str:
    return path.relative_to(settings.vault_path).as_posix()


def _is_visible(settings: Settings, path: Path) -> bool:
    if settings.include_dot_obsidian:
        return True
    try:
        return ".obsidian" not in path.relative_to(settings.vault_path).parts
    except ValueError:
        return False


def _is_readable_text(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in TEXT_EXTENSIONS


def _read_text(settings: Settings, path: Path) -> str:
    if not path.exists() or not path.is_file():
        raise ValueError(f"File does not exist: {_relative(settings, path)}")
    if not _is_readable_text(path):
        raise ValueError(f"Unsupported text file extension: {path.suffix}")
    size = path.stat().st_size
    if size > settings.max_file_bytes:
        raise ValueError(f"File is larger than OBSIDIAN_READER_MAX_FILE_BYTES: {size} bytes")
    return path.read_text(encoding="utf-8-sig", errors="replace")


def _iter_text_files(settings: Settings, directory: Path | None = None):
    root = directory or settings.vault_path
    for path in root.rglob("*"):
        if _is_visible(settings, path) and _is_readable_text(path):
            yield path


def _extract_frontmatter(text: str) -> dict[str, str]:
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}

    metadata: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip()
    return metadata


def _extract_links(text: str) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []

    for match in WIKILINK_RE.finditer(text):
        target = match.group(1) or match.group(2) or ""
        target = target.split("|", 1)[0].split("#", 1)[0].strip()
        if target:
            links.append({"type": "wikilink", "target": target})

    for match in MARKDOWN_LINK_RE.finditer(text):
        target = match.group(1).strip()
        if target and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
            links.append({"type": "markdown", "target": target})

    return links


def _note_id_candidates(settings: Settings, target: str) -> set[str]:
    path = _safe_relative_path(settings, target)
    rel = _relative(settings, path)
    stem = path.stem
    no_suffix = str(Path(rel).with_suffix("")).replace("\\", "/")
    return {
        target.strip(),
        rel,
        rel.replace("\\", "/"),
        no_suffix,
        stem,
    }


def _line_context(text: str, needle: str, context_chars: int = 120) -> str:
    index = text.lower().find(needle.lower())
    if index < 0:
        return ""
    start = max(0, index - context_chars)
    end = min(len(text), index + len(needle) + context_chars)
    return text[start:end].replace("\n", " ").strip()


mcp = FastMCP("obsidian-reader")


@mcp.tool()
def list_notes(directory: str = "", limit: int = 200) -> dict[str, Any]:
    """List files and directories inside the configured Obsidian vault."""
    settings = load_settings()
    root = _safe_relative_path(settings, directory)
    if not root.exists() or not root.is_dir():
        raise ValueError("directory must point to an existing folder.")

    entries: list[dict[str, Any]] = []
    for child in sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if not _is_visible(settings, child):
            continue
        entries.append(
            {
                "path": _relative(settings, child),
                "name": child.name,
                "type": "directory" if child.is_dir() else "file",
                "size": child.stat().st_size if child.is_file() else None,
                "modified": datetime.fromtimestamp(child.stat().st_mtime).isoformat(timespec="seconds"),
            }
        )
        if len(entries) >= max(1, min(limit, 1000)):
            break

    return {"vault": str(settings.vault_path), "directory": directory, "entries": entries}


@mcp.tool()
def read_note(path: str, max_chars: int = 40000) -> dict[str, Any]:
    """Read a Markdown, Canvas, JSON, YAML, CSV, or text file from the vault."""
    settings = load_settings()
    note_path = _safe_relative_path(settings, path)
    text = _read_text(settings, note_path)
    max_chars = max(100, min(max_chars, 200000))
    truncated = len(text) > max_chars
    return {
        "path": _relative(settings, note_path),
        "content": text[:max_chars],
        "truncated": truncated,
        "characters": len(text),
    }


@mcp.tool()
def search_notes(query: str, directory: str = "", limit: int = 50) -> dict[str, Any]:
    """Search text files in the vault for a case-insensitive query."""
    if not query.strip():
        raise ValueError("query is required.")

    settings = load_settings()
    root = _safe_relative_path(settings, directory)
    if not root.exists() or not root.is_dir():
        raise ValueError("directory must point to an existing folder.")

    results: list[dict[str, Any]] = []
    for path in _iter_text_files(settings, root):
        try:
            text = _read_text(settings, path)
        except ValueError:
            continue

        if query.lower() not in text.lower():
            continue
        results.append(
            {
                "path": _relative(settings, path),
                "title": path.stem,
                "context": _line_context(text, query),
            }
        )
        if len(results) >= max(1, min(limit, 200)):
            break

    return {"query": query, "results": results}


@mcp.tool()
def get_note_metadata(path: str) -> dict[str, Any]:
    """Extract lightweight metadata from one note."""
    settings = load_settings()
    note_path = _safe_relative_path(settings, path)
    text = _read_text(settings, note_path)
    headings = [
        {"level": len(match.group(1)), "text": match.group(2).strip()}
        for match in HEADING_RE.finditer(text)
    ]
    return {
        "path": _relative(settings, note_path),
        "title": headings[0]["text"] if headings else note_path.stem,
        "size": note_path.stat().st_size,
        "modified": datetime.fromtimestamp(note_path.stat().st_mtime).isoformat(timespec="seconds"),
        "frontmatter": _extract_frontmatter(text),
        "headings": headings,
        "links": _extract_links(text),
    }


@mcp.tool()
def find_backlinks(target: str, limit: int = 100) -> dict[str, Any]:
    """Find notes that link to a target note path or title."""
    settings = load_settings()
    candidates = {candidate.lower() for candidate in _note_id_candidates(settings, target) if candidate}
    backlinks: list[dict[str, Any]] = []

    for path in _iter_text_files(settings):
        try:
            text = _read_text(settings, path)
        except ValueError:
            continue

        matched_links = [
            link for link in _extract_links(text)
            if link["target"].strip().lower() in candidates
        ]
        if not matched_links:
            continue

        backlinks.append(
            {
                "path": _relative(settings, path),
                "title": path.stem,
                "links": matched_links,
            }
        )
        if len(backlinks) >= max(1, min(limit, 500)):
            break

    return {"target": target, "backlinks": backlinks}


def main() -> None:
    load_settings()
    mcp.run()


if __name__ == "__main__":
    main()

