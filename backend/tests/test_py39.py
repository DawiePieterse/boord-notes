"""The farm PC's Python can be 3.9 (install.ps1 accepts it), and the tests
run on a newer one, so a 3.10-only spelling passes here and stops the server
starting there. `X | None` in a def line is evaluated at import time, and
that TypeError took backup.py - and with it main.py - down at startup; the
test suite never saw it. A `match` statement is a SyntaxError there too."""
import ast
import os

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _py_files():
    for root, dirs, files in os.walk(BACKEND):
        dirs[:] = [d for d in dirs if d not in (".venv", "__pycache__")]
        for f in files:
            if f.endswith(".py"):
                yield os.path.join(root, f)


def _py310_only(src: str, where: str = "<src>") -> list:
    """Each use of a 3.10-only spelling in `src`: a match statement, or an
    `X | Y` annotation evaluated at import time (no `from __future__
    import annotations`)."""
    tree = ast.parse(src)
    future = any(isinstance(n, ast.ImportFrom) and n.module == "__future__"
                 and any(a.name == "annotations" for a in n.names) for n in tree.body)
    problems = []
    for node in ast.walk(tree):
        if type(node).__name__ == "Match":
            problems.append(f"{where}:{node.lineno}: match statement")
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not future:
            annotations = [a.annotation for a in node.args.args + node.args.kwonlyargs
                           if a.annotation is not None]
            if node.returns is not None:
                annotations.append(node.returns)
            for ann in annotations:
                if isinstance(ann, ast.BinOp) and isinstance(ann.op, ast.BitOr):
                    problems.append(f"{where}:{ann.lineno}: `X | Y` annotation needs Optional/Union on 3.9")
    return problems


def test_checker_sees_the_line_that_broke_startup():
    bad = "from datetime import datetime\ndef _last_backup_time() -> datetime | None:\n    return None\n"
    assert len(_py310_only(bad)) == 1
    assert _py310_only("from __future__ import annotations\n" + bad) == []
    assert _py310_only("from typing import Optional\nfrom datetime import datetime\n"
                       "def f() -> Optional[datetime]:\n    return None\n") == []


def test_no_python_310_only_syntax_in_the_backend():
    problems = []
    for path in _py_files():
        with open(path, encoding="utf-8") as fh:
            problems += _py310_only(fh.read(), os.path.relpath(path, BACKEND))
    assert problems == []
