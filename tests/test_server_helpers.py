from pathlib import Path

import pytest

from obsidian_reader_mcp.server import (
    Settings,
    _extract_frontmatter,
    _extract_links,
    _safe_relative_path,
    find_backlinks,
    get_note_metadata,
    list_notes,
    read_note,
    search_notes,
)


def settings(tmp_path: Path) -> Settings:
    return Settings(vault_path=tmp_path.resolve(), include_dot_obsidian=False, max_file_bytes=1024)


def test_safe_relative_path_rejects_escape(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="escapes"):
        _safe_relative_path(settings(tmp_path), "../outside.md")


def test_safe_relative_path_rejects_dot_obsidian_by_default(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match=".obsidian"):
        _safe_relative_path(settings(tmp_path), ".obsidian/app.json")


def test_extract_links_supports_wikilinks_and_markdown_links() -> None:
    text = "See [[Folder/Note#Heading|alias]], ![[Image.png]], and [local](Other.md)."
    assert _extract_links(text) == [
        {"type": "wikilink", "target": "Folder/Note"},
        {"type": "wikilink", "target": "Image.png"},
        {"type": "markdown", "target": "Other.md"},
    ]


def test_extract_frontmatter_reads_simple_keys() -> None:
    text = "---\ntags: mcp, obsidian\nstatus: draft\n---\n# Title"
    assert _extract_frontmatter(text) == {"tags": "mcp, obsidian", "status": "draft"}


def test_tools_read_search_and_find_backlinks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "Inbox").mkdir()
    (tmp_path / "Inbox" / "Project.md").write_text(
        "---\nstatus: active\n---\n# Project\nMCP search target\n[[Reference]]\n",
        encoding="utf-8",
    )
    (tmp_path / "Reference.md").write_text("# Reference\nBack to [[Project]].\n", encoding="utf-8")
    (tmp_path / ".obsidian").mkdir()
    (tmp_path / ".obsidian" / "app.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("OBSIDIAN_VAULT_PATH", str(tmp_path))

    listed = list_notes()
    assert [entry["path"] for entry in listed["entries"]] == ["Inbox", "Reference.md"]

    read = read_note("Inbox/Project.md")
    assert "MCP search target" in read["content"]

    search = search_notes("search target")
    assert search["results"][0]["path"] == "Inbox/Project.md"

    metadata = get_note_metadata("Inbox/Project.md")
    assert metadata["title"] == "Project"
    assert metadata["frontmatter"] == {"status": "active"}

    backlinks = find_backlinks("Inbox/Project.md")
    assert backlinks["backlinks"][0]["path"] == "Reference.md"
