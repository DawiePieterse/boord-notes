"""update_server.bat must stop the server for real before it touches the
database. A bare "schtasks /end" ends only the launcher: the uvicorn process
it started keeps port 8020, the new release cannot bind it, and the old server
goes on answering. On the farm PC that kept a server from before v2.16 running
while the folder was on v2.17, and the updater reported success.

Same test as Boord Owner's tests/test_updater.py.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _updater_commands() -> str:
    # The script's commands only. Its :: comments name "schtasks /end" to say
    # why it is not used, and that must not count as using it.
    with open(os.path.join(ROOT, "update_server.bat"), encoding="utf-8") as fh:
        return "".join(line for line in fh if not line.lstrip().startswith("::"))


def test_updater_stops_the_server_before_touching_the_database():
    text = _updater_commands()
    stop = text.find("stop_server.ps1")
    assert stop != -1
    assert stop < text.find("create_db_and_tables")
    assert "schtasks /end" not in text


def test_updater_starts_the_new_file_after_the_checkout():
    """cmd reads a batch file off the disk as it runs, so once the checkout has
    replaced the updater it must start the new file from the top, as the last
    thing in that block: anything after it would be read at a stale byte of
    the new file (Boord Packhouse v0.66 ended "failed" that way, the server never restarted)."""
    with open(os.path.join(ROOT, "update_server.bat"), encoding="utf-8") as fh:
        text = fh.read()
    assert re.search(r'git checkout --force "!NEWTAG!"\n.*?\n    "%~f0" %\* --checked-out\n\)\n\n'
                     r'echo\.\necho ==\^> Installing', text, re.S)
    # ...and a second time round stops, rather than checking out for ever.
    assert '"%%~A"=="--checked-out"' in text
