#!/usr/bin/env python3
"""Simple PDF text search helper for local vendor manuals."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from pypdf import PdfReader


def iter_matches(pdf_path: Path, needle: str, context: int) -> int:
    reader = PdfReader(str(pdf_path))
    matches = 0

    for page_index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        start = 0

        while True:
            idx = text.find(needle, start)
            if idx < 0:
                break

            excerpt_start = max(0, idx - context)
            excerpt_end = min(len(text), idx + len(needle) + context)
            excerpt = text[excerpt_start:excerpt_end].replace("\x00", "")
            print(f"===== PAGE {page_index} =====")
            print(excerpt)
            print()
            matches += 1
            start = idx + len(needle)

    return matches


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path, help="Path to the PDF file")
    parser.add_argument("needle", help="Case-sensitive text to search for")
    parser.add_argument(
        "--context",
        type=int,
        default=500,
        help="Number of surrounding characters to print",
    )
    args = parser.parse_args()

    if not args.pdf.is_file():
        print(f"PDF not found: {args.pdf}", file=sys.stderr)
        return 2

    matches = iter_matches(args.pdf, args.needle, args.context)
    if matches == 0:
        print("No matches found.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
