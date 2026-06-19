"""
xc-cli — the command-line interface to the Explained Code core.

Commands:
    xc-cli init <raw_file> [-o out.xc] [--module M] [--language L]
    xc-cli extract <file.xc> [-o out] [--hash]
    xc-cli run <file.xc> [-- args...]
    xc-cli validate <file.xc>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import core
from .core import code_hash, extract, init_from_file, run, validate


def _read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def cmd_init(args: argparse.Namespace) -> int:
    out_text = init_from_file(
        args.path,
        module=args.module,
        language=args.language,
    )
    if args.output:
        Path(args.output).write_text(out_text, encoding="utf-8")
        print(f"wrote {args.output}", file=sys.stderr)
    else:
        default = Path(args.path).with_suffix(".xc")
        Path(default).write_text(out_text, encoding="utf-8")
        print(f"wrote {default}", file=sys.stderr)
    return 0


def cmd_extract(args: argparse.Namespace) -> int:
    text = _read(args.path)
    if args.hash:
        print(code_hash(text))
        return 0
    code = extract(text)
    if args.output:
        Path(args.output).write_text(code, encoding="utf-8")
        print(f"wrote {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(code)
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    text = _read(args.path)
    try:
        return run(text, extra_args=args.args or None)
    except ValueError as e:
        print(f"xc-cli run: {e}", file=sys.stderr)
        return 2


def cmd_validate(args: argparse.Namespace) -> int:
    text = _read(args.path)
    report = validate(text)
    print(report.render())
    return 0 if report.ok else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="xc-cli",
        description="Tooling for the .xc (Explained Code) Markdown-First format.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="wrap a raw source file into .xc")
    p_init.add_argument("path", help="path to a raw source file (.py/.ts/.cpp/...)")
    p_init.add_argument("-o", "--output", help="output .xc path (default: <name>.xc)")
    p_init.add_argument("--module", help="module name for frontmatter")
    p_init.add_argument("--language", help="override detected language")
    p_init.set_defaults(func=cmd_init)

    p_ext = sub.add_parser("extract", help="emit pure code from a .xc file")
    p_ext.add_argument("path", help="path to a .xc file")
    p_ext.add_argument("-o", "--output", help="write code to file instead of stdout")
    p_ext.add_argument("--hash", action="store_true",
                       help="print SHA-256 of extracted code instead of the code")
    p_ext.set_defaults(func=cmd_extract)

    p_run = sub.add_parser("run", help="extract and execute a .xc file")
    p_run.add_argument("path", help="path to a .xc file")
    p_run.add_argument("args", nargs=argparse.REMAINDER,
                       help="arguments passed to the program (after --)")
    p_run.set_defaults(func=cmd_run)

    p_val = sub.add_parser("validate", help="structural + YAML validation")
    p_val.add_argument("path", help="path to a .xc file")
    p_val.set_defaults(func=cmd_validate)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    # argparse REMAINDER keeps a leading "--"; drop it.
    if getattr(args, "args", None) and args.args and args.args[0] == "--":
        args.args = args.args[1:]
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
