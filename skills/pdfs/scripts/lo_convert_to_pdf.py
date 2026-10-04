#!/usr/bin/env python3
"""Convert an Office document (DOCX/PPTX/ODT/...) to PDF using LibreOffice.

Examples:
  python lo_convert_to_pdf.py input.docx --out_dir /mnt/data/out
  python lo_convert_to_pdf.py deck.pptx --out_dir /mnt/data/out

Notes:
- Conversion quality varies by file. Always render the output PDF to images and inspect.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import tempfile
from pathlib import Path


def _build_lo_env(user_profile: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(user_profile)
    env["XDG_CONFIG_HOME"] = str(user_profile / "xdg_config")
    env["XDG_CACHE_HOME"] = str(user_profile / "xdg_cache")
    Path(env["XDG_CONFIG_HOME"]).mkdir(parents=True, exist_ok=True)
    Path(env["XDG_CACHE_HOME"]).mkdir(parents=True, exist_ok=True)
    return env


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input_file")
    p.add_argument("--out_dir", required=True)
    p.add_argument("--timeout_s", type=int, default=180)
    args = p.parse_args()

    inp = Path(args.input_file)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_pdf = out_dir / f"{inp.stem}.pdf"
    preexisting_pdfs = {p.resolve() for p in out_dir.glob("*.pdf")}
    out_pdf.unlink(missing_ok=True)
    preexisting_pdfs.discard(out_pdf.resolve())

    with tempfile.TemporaryDirectory(prefix="soffice_profile_") as user_profile_dir:
        user_profile = Path(user_profile_dir)
        cmd = [
            "soffice",
            "-env:UserInstallation=" + user_profile.resolve().as_uri(),
            "--invisible",
            "--headless",
            "--norestore",
            "--nologo",
            "--nolockcheck",
            "--convert-to",
            "pdf",
            "--outdir",
            str(out_dir),
            str(inp),
        ]
        print(" ".join(cmd))

        # LibreOffice can occasionally exit non-zero while still writing output.
        # Treat existence + readability of the output PDF as the primary success signal.
        try:
            proc = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                env=_build_lo_env(user_profile),
                timeout=args.timeout_s,
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(
                "LibreOffice conversion timed out.\n"
                f"timeout_s={args.timeout_s}\nstdout={e.stdout}\nstderr={e.stderr}"
            ) from e

    if not out_pdf.exists():
        new_matches = [
            p
            for p in out_dir.glob("*.pdf")
            if p.resolve() not in preexisting_pdfs and p.stat().st_size > 0
        ]
        if len(new_matches) == 1:
            out_pdf = new_matches[0]

    if not out_pdf.exists() or out_pdf.stat().st_size == 0:
        raise RuntimeError(
            "LibreOffice conversion did not produce a PDF.\n"
            f"exit={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}"
        )

    # Sanity-check that the PDF is parseable and non-empty.
    try:
        from pypdf import PdfReader

        r = PdfReader(str(out_pdf))
        if len(r.pages) == 0:
            raise RuntimeError("Output PDF has zero pages")
    except Exception as e:
        raise RuntimeError(
            "LibreOffice produced a PDF, but it does not appear to be a valid PDF.\n"
            f"exit={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}"
        ) from e

    if proc.returncode != 0:
        print(f"[WARN] soffice exited with code {proc.returncode}, but output PDF looks valid.")
    print(str(out_pdf))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
