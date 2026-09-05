#!/usr/bin/env python3
"""Catch the PowerShell parse errors a Mac can't catch by running the script.

Chiefly: "$Name:" inside a double-quoted string. PowerShell reads a colon
after a variable name as a DRIVE qualifier (the way $env:PATH works), so any
other name there is a fatal parse error - fatal meaning the whole script
fails to load, before its first line runs.

Walks the file with a small state machine so it can tell code from comments,
single-quoted strings, double-quoted strings and here-strings apart.
"""
import re, sys

SCOPES = {"env", "global", "script", "local", "private", "using",
          "variable", "function", "alias", "workflow"}


def lint(path):
    src = open(path, encoding="utf-8").read()
    lines = src.split("\n")
    problems = []

    in_here = False          # inside @" ... "@
    for ln, line in enumerate(lines, 1):
        if in_here:
            if line.startswith('"@'):
                in_here = False
            else:
                check_interp(line, ln, path, problems, where="here-string")
            continue
        if re.search(r'@"\s*$', line):
            in_here = True
            continue

        i, n = 0, len(line)
        dq = sq = False
        while i < n:
            c = line[i]
            if not dq and not sq and c == "#":
                break                                  # comment to EOL
            if not sq and c == '`':                    # backtick escape
                i += 2; continue
            if not sq and c == '"':
                if dq and i + 1 < n and line[i + 1] == '"':
                    i += 2; continue                   # "" is a literal quote
                dq = not dq; i += 1; continue
            if not dq and c == "'":
                sq = not sq; i += 1; continue
            if dq and c == "$":
                m = re.match(r'\$([A-Za-z_][A-Za-z0-9_]*)', line[i:])
                if m:
                    end = i + m.end()
                    if end < n and line[end] == ":" and m.group(1).lower() not in SCOPES:
                        problems.append(
                            (ln, f'"${m.group(1)}:" - colon after a variable is read as a '
                                 f'drive qualifier; write "${{{m.group(1)}}}:"'))
                    i = end; continue
            i += 1
        if dq:
            problems.append((ln, "unterminated double-quoted string"))
        if sq:
            problems.append((ln, "unterminated single-quoted string"))

    for tok, name in (("{", "brace"), ("(", "paren")):
        close = {"{": "}", "(": ")"}[tok]
        if src.count(tok) != src.count(close):
            problems.append((0, f"unbalanced {name}s: {src.count(tok)} vs {src.count(close)}"))
    if in_here:
        problems.append((0, "unterminated here-string"))
    return problems


def check_interp(line, ln, path, problems, where):
    for m in re.finditer(r'\$([A-Za-z_][A-Za-z0-9_]*):', line):
        if m.group(1).lower() not in SCOPES:
            problems.append((ln, f'{where}: "${m.group(1)}:" needs ${{{m.group(1)}}}'))


if __name__ == "__main__":
    bad = 0
    for path in sys.argv[1:]:
        ps = lint(path)
        if ps:
            bad = 1
            print(f"{path}:")
            for ln, msg in ps:
                print(f"  line {ln}: {msg}")
        else:
            print(f"{path}: clean")
    sys.exit(bad)
