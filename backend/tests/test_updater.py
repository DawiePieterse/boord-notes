"""update_server.bat must stop the server for real before it touches the
database. A bare "schtasks /end" ends only the launcher: the uvicorn process
it started keeps port 8020, the new release cannot bind it, and the old server
goes on answering. On the farm PC that kept a server from before v2.16 running
while the folder was on v2.17, and the updater reported success.

Same test as Boord Owner's tests/test_updater.py.
"""
import os

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
