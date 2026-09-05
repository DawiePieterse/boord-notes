#!/usr/bin/env python3
"""Remove the credential columns left behind when the sign-in was removed.

Up to v2.0 this app had two accounts, and `user.password_hash` held a bcrypt
hash for each. v2.1 removed the sign-in entirely; models.User no longer maps
password_hash or role, and nothing reads them. But db.py's migration is
strictly additive - it never drops anything - so on a notebook.db that
predates v2.1 the column and the two hashes are still sitting there, unread.

This drops `password_hash` and `role` outright and VACUUMs, which is what
actually removes the bytes: blanking the values would leave the originals in
freelist pages until some later write happened to reuse them.

Safe to re-run; it reports and exits when there is nothing to do. A fresh
v2.1 install never had the columns and does not need this at all.

    python scripts\\clear_legacy_password_hashes.py

**Stop the server first** - `schtasks /end /tn "Boord Notes Server"` - because
ALTER TABLE and VACUUM need an exclusive lock on the database, and the script
will refuse rather than wait if the server still holds it.

ONE-WAY. After this, checking out v2.0 again gives you back the login screen
with no usable passwords and no reset path short of editing the database by
hand. If rolling back is a live possibility, keep the backup this takes.
"""
import os
import shutil
import sqlite3
import sys
from datetime import datetime

LEGACY_COLUMNS = ("password_hash", "role")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(REPO_ROOT, "data", "notebook.db")


def main(db_path):
    if not os.path.exists(db_path):
        print(f"No database at {db_path}")
        return 1

    con = sqlite3.connect(db_path)
    try:
        present = [r[1] for r in con.execute("pragma table_info(user)")]
        if not present:
            print("No user table - nothing to do.")
            return 0
        stale = [c for c in LEGACY_COLUMNS if c in present]
        if not stale:
            print("Already clean: no password_hash or role column on user.")
            return 0

        rows = con.execute("select count(*) from user").fetchone()[0]
        print(f"Database : {db_path}")
        print(f"Columns  : {', '.join(stale)}")
        print(f"User rows: {rows}")

        # Snapshot before touching anything, in the same spirit as
        # update_server.bat's pre-migration copy. Kept per-run, not overwritten.
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_dir = os.path.join(os.path.dirname(db_path), "backups")
        os.makedirs(backup_dir, exist_ok=True)
        backup = os.path.join(backup_dir, f"notebook-before-clearhashes-{stamp}.db")
        con.close()
        shutil.copy2(db_path, backup)
        print(f"Backup   : {backup}")

        con = sqlite3.connect(db_path)
        # DROP COLUMN needs SQLite 3.35 (2021). Older builds get the values
        # blanked instead, which is worth less but is better than nothing and
        # never leaves the script half-applied.
        version = tuple(int(p) for p in sqlite3.sqlite_version.split("."))
        if version >= (3, 35, 0):
            for col in stale:
                con.execute(f"alter table user drop column {col}")
            con.commit()
            print(f"Dropped  : {', '.join(stale)} (SQLite {sqlite3.sqlite_version})")
        else:
            if "password_hash" in stale:
                con.execute("update user set password_hash = ''")
            con.commit()
            print(f"SQLite {sqlite3.sqlite_version} is too old to DROP COLUMN.")
            print("Blanked the hashes instead; the columns remain.")

        # VACUUM rewrites the file, which is what actually discards the old
        # pages. Without it the dropped values linger in free space.
        con.execute("vacuum")
        con.commit()
        print("Vacuumed : old pages discarded")
    except sqlite3.OperationalError as e:
        print(f"\nDatabase is busy or locked: {e}")
        print('Stop the server first:  schtasks /end /tn "Boord Notes Server"')
        print("then run this again, and start it afterwards with /run.")
        return 1
    finally:
        con.close()

    con = sqlite3.connect(db_path)
    after = [r[1] for r in con.execute("pragma table_info(user)")]
    con.close()
    print(f"user columns now: {after}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB))
