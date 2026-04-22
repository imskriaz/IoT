#!/usr/bin/env python3
"""Convert PDF text into a simple Markdown document with light structure."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
from typing import Iterable

from pypdf import PdfReader


SIMCOM_PAGE_RE = re.compile(r"^www\.simcom\.com\s+\d+\s*/\s*\d+$", re.IGNORECASE)
TOC_RE = re.compile(r"^(?P<title>.+?)\s\.{4,}\s*(?P<page>\d+)$")
SECTION_RE = re.compile(r"^(?P<number>\d+(?:\.\d+)+)\s+(?P<title>.+)$")
COMMAND_SECTION_RE = re.compile(r"^(?P<command>AT\+[A-Z0-9*][^\s]*)\s+(?P<title>.+)$")
META_FIELD_RE = re.compile(
    r"^(?P<label>Document Title|Version|Date|Status):\s*(?P<value>.+)$"
)
DETAIL_FIELD_RE = re.compile(
    r"^(?P<label>Parameter Saving Mode|Maximum Response Time|Max Response Time|Reference)\s*:?\s*(?P<value>.*)$"
)
ALL_CAPS_HEADING_RE = re.compile(r"^[A-Z][A-Z0-9()\/&,\- ]{2,}$")

SECTION_LABELS = {
    "About Document",
    "Version History",
    "Test Command",
    "Read Command",
    "Write Command",
    "Execution Command",
    "Execute Command",
    "Response",
    "Examples",
    "Defined Values",
    "Parameter Saving Mode",
    "Reference",
    "Contents",
    "Introduction",
}

STATUS_LINES = {
    "OK",
    "ERROR",
    "NO CARRIER",
    "CONNECT FAIL",
}


def normalize_text(text: str) -> str:
    text = text.replace("\x00", "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u2010", "-")
    text = text.replace("\u2011", "-")
    text = text.replace("\u2012", "-")
    text = text.replace("\u2013", "-")
    text = text.replace("\u2014", "-")
    text = text.replace("\u2018", "'")
    text = text.replace("\u2019", "'")
    text = text.replace("\u201c", '"')
    text = text.replace("\u201d", '"')
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_common_page_header(lines: list[str]) -> list[str]:
    trimmed = [line.strip() for line in lines]
    while trimmed and not trimmed[0]:
        trimmed.pop(0)

    if len(trimmed) >= 2 and SIMCOM_PAGE_RE.match(trimmed[1]):
        trimmed = trimmed[2:]
    elif trimmed and SIMCOM_PAGE_RE.match(trimmed[0]):
        trimmed = trimmed[1:]

    while trimmed and not trimmed[0]:
        trimmed.pop(0)

    return trimmed


def format_line(line: str) -> str:
    line = line.strip()
    if not line:
        return ""

    field_match = META_FIELD_RE.match(line)
    if field_match:
        label = field_match.group("label")
        value = field_match.group("value").strip()
        return f"- **{label}:** {value}"

    detail_match = DETAIL_FIELD_RE.match(line)
    if detail_match:
        label = detail_match.group("label")
        value = detail_match.group("value").strip()
        if value:
            return f"- **{label}:** {value}"
        return f"### {label}"

    toc_match = TOC_RE.match(line)
    if toc_match:
        title = toc_match.group("title").strip()
        page = toc_match.group("page")
        return f"- {title} (page {page})"

    section_match = SECTION_RE.match(line)
    if section_match:
        number = section_match.group("number")
        title = section_match.group("title").strip()
        level = min(number.count(".") + 1, 6)
        hashes = "#" * max(level, 2)
        return f"{hashes} {number} {title}"

    command_match = COMMAND_SECTION_RE.match(line)
    if command_match and "=" not in line and "?" not in line:
        command = command_match.group("command")
        title = command_match.group("title").strip()
        return f"##### {command} {title}"

    if line in SECTION_LABELS:
        return f"### {line}"

    if line.startswith("NOTE:"):
        return f"> {line}"

    if line in STATUS_LINES:
        return line

    if ALL_CAPS_HEADING_RE.match(line) and len(line.split()) <= 8:
        return f"## {line.title()}"

    return line


def render_page(page_index: int, text: str) -> list[str]:
    raw_lines = text.splitlines()
    lines = strip_common_page_header(raw_lines)
    rendered: list[str] = [f"## PDF Page {page_index}", ""]

    for raw_line in lines:
        line = format_line(raw_line)
        if line:
            rendered.append(line)
        elif rendered and rendered[-1] != "":
            rendered.append("")

    while rendered and rendered[-1] == "":
        rendered.pop()

    rendered.append("")
    return rendered


def infer_title(pdf_path: Path, reader: PdfReader) -> str:
    meta = reader.metadata or {}
    title = getattr(meta, "title", None) or meta.get("/Title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    return pdf_path.stem


def render_markdown(pdf_path: Path, reader: PdfReader) -> str:
    title = infer_title(pdf_path, reader)
    lines: list[str] = []

    lines.append(f"# {title}")
    lines.append("")
    lines.append(f"Source PDF: [{pdf_path.name}](./{pdf_path.name})")
    lines.append("")
    lines.append(f"Total pages: {len(reader.pages)}")
    lines.append("")
    lines.append("> Auto-generated from the PDF text layer. Layout-heavy pages may lose table, column, and diagram fidelity.")
    lines.append("")

    for page_index, page in enumerate(reader.pages, start=1):
        text = normalize_text(page.extract_text() or "")
        if text:
            lines.extend(render_page(page_index, text))
        else:
            lines.append(f"## PDF Page {page_index}")
            lines.append("")
            lines.append("_No extractable text on this page._")
            lines.append("")

    return "\n".join(lines)


def iter_pdfs(path: Path, recursive: bool) -> Iterable[Path]:
    if path.is_file():
        if path.suffix.lower() == ".pdf":
            yield path
        return

    pattern = "**/*.pdf" if recursive else "*.pdf"
    for pdf_path in sorted(path.glob(pattern)):
        if pdf_path.is_file():
            yield pdf_path


def convert_pdf(pdf_path: Path, output_path: Path) -> None:
    reader = PdfReader(str(pdf_path))
    markdown = render_markdown(pdf_path, reader)
    output_path.write_text(markdown, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="PDF file or directory")
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="When a directory is given, include PDFs in subdirectories",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing Markdown outputs",
    )
    args = parser.parse_args()

    converted = 0
    skipped = 0

    for pdf_path in iter_pdfs(args.path, args.recursive):
        output_path = pdf_path.with_suffix(".md")
        if output_path.exists() and not args.force:
            skipped += 1
            continue
        convert_pdf(pdf_path, output_path)
        print(f"wrote {output_path}")
        converted += 1

    print(f"converted={converted} skipped={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
