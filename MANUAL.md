# Boord Notes - User & Admin Manual

A private, two-person app for Andre to capture farm knowledge - procedures,
equipment quirks, seasonal timing, anything worth handing over - so his son
has it all in one place later.

It is the third of the Boord apps and runs beside the other two on the farm
server: its own process, its own port, its own database, its own auto-start
task. Nothing here reads or writes Boord's data - the only things the three
share are the machine they run on, the tailnet that reaches them, and the
release key that signs their updates.

| App | Local port | Tailscale address |
| --- | --- | --- |
| Boord | 8000 | `https://<server>.<tailnet>.ts.net/` |
| Boord Owner | 8010 | `https://<server>.<tailnet>.ts.net:8443/` |
| **Boord Notes** | **8020** | **`https://<server>.<tailnet>.ts.net:9443/app/`** |

## Table of Contents

1. [Overview & Concepts](#1-overview--concepts)
2. [Initial Server Setup](#2-initial-server-setup)
3. [Device Setup (iPhone)](#3-device-setup-iphone)
   - [This app's address](#this-apps-address)
4. [Using the App](#4-using-the-app)
5. [How Offline Capture Works](#5-how-offline-capture-works)
6. [Backups & Restore](#6-backups--restore)
7. [Troubleshooting / FAQ](#7-troubleshooting--faq)

Annexe A: [Data Field Reference](#annexe-a-data-field-reference)

---

## 1. Overview & Concepts

### There is no sign-in

The app opens straight onto the Dashboard. There are no accounts, no
passwords, and no roles: **anyone who can reach it can read every note, and
add, edit or archive notes.** Reaching it is the entire access control, and
that means Tailscale - see
[Tailscale HTTPS](#tailscale-https-required-for-the-installable-offline-app).

This matches Boord Owner, which has no sign-in either, but the consequence is
larger here and is worth being clear about. Owner is read-only by
construction. This app is not: every device on the farm's tailnet, including
the field phones the harvest crew carry, can change or archive what Andre has
recorded. Removing a device in the Tailscale admin console is the only way to
take that away - there is no account to disable and no password to change.

Notes captured before the sign-in was removed still show who wrote them.
Notes captured since show no author, because nothing knows who is typing.

### No audio is ever stored

Andre doesn't record voice notes in the sense of an audio file. He taps the
**microphone key on his iPhone's own keyboard** and dictates straight into
the Notes field, using Apple's built-in dictation (which handles both
Afrikaans and South African English). The app only ever sees and stores the
resulting **text** - there is no audio file anywhere, no transcription
service, and no recording of any kind.

### What an entry is

Title + notes (the dictated text) + an optional Block/Location + any number
of photos, taken with the phone's own camera + free-form tags Andre defines
as he goes. Every entry remembers who wrote it and when.

### Why capture is offline-first

Andre will often be out on the farm with patchy or no signal. Saving an
entry always writes to the phone first, instantly, whether or not there's a
connection - it syncs to the server automatically in the background once
signal returns. Nothing is ever lost waiting for a connection. See
[chapter 5](#5-how-offline-capture-works) for exactly how this works and
what to watch for.

---

## 2. Initial Server Setup

This app runs as an **independent process on the same PC** as Boord and
Boord Owner. It shares no port, database, or Scheduled Task with either -
all three can be stopped, started, and updated independently.

### Prerequisites

- Windows 10/11 PC (or Mac/Linux, run manually - see Boord's manual for the
  equivalent non-Windows steps, which apply identically here).
- The PC stays on and connected to the network whenever Andre or his son
  need to reach the app.
- Internet access for the one-time setup (downloading Python and
  dependencies) and for pulling future updates via `update_server.bat`.
- **Tailscale**, installed and signed in on this PC. It is not optional for
  this app - see [Tailscale HTTPS](#tailscale-https-required-for-the-installable-offline-app)
  below. The server itself is bound to `127.0.0.1` and cannot be reached
  from the farm's wifi at all.
- **GnuPG** (Gpg4win), if you want to be able to install updates. Boord's
  own installer sets this up; if this PC already runs Boord, it is done.

### Quick setup: the automated installer (recommended)

1. Get this folder onto the server PC (clone via git, or copy as a zip -
   whichever this repo's GitHub remote makes easiest).
2. Double-click **`install.bat`**.
3. Approve the Windows "Do you want to allow this app..." prompt (User
   Account Control) - the installer needs administrator rights once to
   register the Scheduled Task and to close the old firewall rule.
4. Wait for it to finish - it installs Python if needed, creates the app's
   virtual environment, installs dependencies, imports the release signing
   key, and registers a Scheduled Task ("Boord Notes Server") so the server
   starts automatically every time the PC boots, with no one needing to be
   logged in.
5. It prints the `tailscale serve` command that publishes the app, and the
   one manual step left: writing the release key fingerprint into
   `data\release_key.fpr` (see [Pulling future updates](#pulling-future-updates)).

Note what it deliberately does **not** do: it does not open a firewall port,
and it **deletes** the port-8001 rule older versions of this installer added.
The server binds `127.0.0.1`, so there is nothing for an inbound rule to
reach. A server that has been running since before this change has to have
that rule closed, or the loopback bind buys nothing on exactly the machine
that has been exposed longest. The installer also removes the old
"Bekfontein Farm Notebook Server" task, so the PC does not boot two copies.

Safe to re-run any time - each step checks what's already done and skips it.

### Upgrading the server that is already running (one time only)

A farm server installed before the rename cannot reach this release through
its own `update_server.bat`, because that file is *itself* one of the things
being replaced - the new one refuses to install anything until a release key
fingerprint exists, and the old checkout has neither the fingerprint nor
`release-key.asc`. Do it in this order, once:

1. **Double-click the *existing* `update_server.bat`.** The old one still
   does a plain `git pull`, which is exactly what is needed here: it brings
   down the renamed app, the release key, and the new installer and updater.
   It then restarts the server under the old task, still on port 8001 - the
   new code runs there perfectly well, so nothing is broken while you finish.

   The GitHub repository has been renamed too, but GitHub redirects the old
   URL, so the existing `origin` keeps working and needs no attention.

2. **Double-click `install.bat`.** This is the step that actually moves the
   app: new port, loopback bind, old firewall rule closed, old Scheduled Task
   removed and the "Boord Notes Server" one registered in its place.

3. **Write the release key fingerprint** into `data\release_key.fpr` - see
   [Pulling future updates](#pulling-future-updates) for the exact command.

4. **Re-point Tailscale**, with all three mappings together - see
   [Tailscale HTTPS](#tailscale-https-required-for-the-installable-offline-app).
   This is also what repairs Boord Owner, which has been fighting this app
   for `:8443`.

5. **Re-add the Home Screen icon on both phones**, from the new `:9443`
   address, and clear the old one's website data. The old icon does not just
   stop working - it keeps drawing this app's cached screens over Boord
   Owner's server. See [chapter 7](#7-troubleshooting--faq).

From step 2 onward `update_server.bat` is the signed-tag one, and the next
update is a single double-click again.

### Stopping, starting, and restarting the server

Same mechanism as the other two apps, just a different task name:

```powershell
schtasks /end /tn "Boord Notes Server"
schtasks /run /tn "Boord Notes Server"
```

### Pulling future updates

Double-click **`update_server.bat`**. It installs the newest **signed**
release, brings the database up to date, and restarts the server - one step,
the same pattern and the same signing key as Boord and Boord Owner.

It does not `git pull` a branch. A branch pull trusts whoever can push to
the repo, and this server runs as SYSTEM, so a stolen GitHub token would be
code execution on the farm PC. Instead it checks out the newest `v*` tag
carrying a GPG signature from the release key, and refuses to update at all
if that signature is missing, broken, or made by any other key.

**One-time setup before the first update will work.** The server has to be
told which key it trusts, and that has to be a person's decision - a
fingerprint the installer wrote for you would be the repo vouching for
itself. In this folder, run:

```bat
>data\release_key.fpr echo 67C64CFDD584DD140E58AF6E329C9B9DD0562A9D
```

Type it exactly like that, **redirect first**. `cmd` reads a digit written
immediately before a `>` as a file handle number, so the more natural
`echo <FINGERPRINT>> data\release_key.fpr` quietly drops a fingerprint's last
character whenever it happens to be a digit - and the next update then fails
its signature check, which reads as tampering rather than as a typo. This
key's fingerprint ends in `D` and would survive either form, but the next one
might not.

It is the same key Boord and Boord Owner already trust on this machine; their
own `data\release_key.fpr` holds the identical value, so you can copy it from
there instead of typing it.

The file lives in `data\` rather than in the checkout on purpose: a
fingerprint inside the repo would be rewritten by the very update it is
supposed to be vouching for.

### Tailscale HTTPS (required for the installable offline app)

This app is reached over Tailscale and no other way. The server binds
`127.0.0.1`, so nothing on the farm's wifi can see it; `tailscale serve` puts
it on the tailnet with a real Let's Encrypt certificate that Tailscale renews
itself. This is the same arrangement Boord Owner uses.

HTTPS is not a nicety here. **Installing the app to the Home Screen and
registering its offline service worker both require a secure context**
(HTTPS, or `localhost`), and so do the camera and a note's GPS location. A
plain `http://192.168.x.x:8020/` address would let Andre open the app in a
browser tab, then silently fail to install, work offline, take a
photo, or record where a note was made - which is the entire point of the app
for someone walking the farm without signal.

Needs **HTTPS Certificates** enabled for the tailnet (admin console → DNS).

**All three mappings, in one place.** `:443` is one slot per machine and this
PC runs three apps, so each needs its own port. Set all three together rather
than adding one - that is the only way to be sure of what the machine ends up
with:

```bat
tailscale serve reset
tailscale serve --bg --https=443  http://localhost:8000
tailscale serve --bg --https=8443 http://localhost:8010
tailscale serve --bg --https=9443 http://localhost:8020
```

Boord takes 443 because its Field QR scanner has to be what the bare address
reaches. Boord Owner takes 8443. This app takes 9443. `tailscale serve status`
should then list all three:

```
$ tailscale serve status
https://<server-name>.<tailnet-name>.ts.net (tailnet only)
|-- / proxy http://localhost:8000          <- Boord

https://<server-name>.<tailnet-name>.ts.net:8443 (tailnet only)
|-- / proxy http://localhost:8010          <- Boord Owner

https://<server-name>.<tailnet-name>.ts.net:9443 (tailnet only)
|-- / proxy http://localhost:8020          <- this app
```

which makes this app's address
`https://<server-name>.<tailnet-name>.ts.net:9443/app/`, filling in the real
server and tailnet names from that output - see
[chapter 3](#this-apps-address).

**Two apps claiming one port does not look like a port clash.** Whichever
`serve` command ran last silently wins, and the loser's address loads and
answers `{"detail":"Not Found"}` - that is the *other* app replying that it
has no such page. Check `tailscale serve status` before suspecting anything
else. Earlier versions of this manual told you to put this app on `:8443`,
which is Boord Owner's port; a server set up from those instructions has one
of the two apps unreachable right now, and the `serve reset` above is the fix.

**Use `serve`, never `funnel`.** Funnel would publish the farm's notes on the
open internet to anyone who guessed the URL.

If Tailscale isn't set up on this server yet, see Boord's `MANUAL.md`
chapter 2, section "Connecting external users with Tailscale" - the setup
steps are identical, this app just needs its own `serve` line.

---

## 3. Device Setup (iPhone)

### Install to Home Screen *before* first use - this matters

**⚠️ Do this before Andre records anything.** If he captures entries in a
plain Safari tab and *then* adds the app to his Home Screen, iOS treats the
installed app as a completely separate storage area from the Safari tab it
came from - anything captured before installing can appear to have
"vanished" when he switches to the Home Screen icon (it's still sitting in
Safari's own storage, just invisible from the installed app). Avoid this
entirely by installing first, then always opening the app from its Home
Screen icon.

### This app's address

```
https://<server-name>.<tailnet-name>.ts.net:9443/app/
```

**Andre and his son open the identical link** and both land straight on the
Dashboard. There is no sign-in, and no separate address for either of them.

Three parts of that address matter, and getting any of them wrong fails in a
way that doesn't look like an address problem:

- **`:9443`** - the farm server runs three apps and each has its own port.
  `https://<server-name>.<tailnet-name>.ts.net` without a port opens *Boord*,
  and `:8443` opens *Boord Owner*.
- **`/app/`** - the app itself lives here. The address without it redirects
  to it, so it is safe to leave off, but the installed Home Screen icon should
  carry it.
- **`https`** - there is no `http://` address any more; the server binds
  loopback. Even if there were, iOS silently refuses to install a plain-HTTP
  page to the Home Screen, run it offline, open the camera, or record a note's
  location. Everything that makes this app worth carrying into the orchard
  needs the HTTPS address.

All three mappings are **tailnet only**, so a phone must be signed in to the
Tailscale network to reach any of them. If the address ever changes, re-check
it on the server with `tailscale serve status` - the line proxying to
`http://localhost:8020` is this app.

**Steps:**
1. Open the address above in Safari on the iPhone.
2. Tap the **Share** icon (square with an arrow) → **"Add to Home Screen"**.
3. From now on, always open **Notes** from the Home Screen icon, not from a
   Safari bookmark or tab. Its icon is the Boord crate with a **sky-blue
   leaf** - the same mark as Boord's other apps, whose leaves are green
   (Field), red (Receiving), yellow (Admin) and white (Owner).

### Dictation

Tap the Notes field, then tap the **microphone icon** on the iOS keyboard
(next to the space bar) to dictate in Afrikaans or English - iOS auto-
detects or can be set per-keyboard under Settings → General → Keyboard →
Keyboards, if it's not picking up the right language. Tap the keyboard icon
again (or tap "Done") to stop dictating and review/edit the text normally.

### Camera

The **Add Photo** button opens the iPhone's native camera directly (not a
generic file picker) - snap a photo and it's attached immediately, resized
automatically on the phone before it's stored, to keep things fast over
weak signal.

---

## 4. Using the App

### Capture

- **Title** - short, e.g. "Irrigation pump quirk".
- **Block / Location** (optional) - free text, e.g. "Block 4 North" or "near
  the pump station".
- **Notes** - the dictated (or typed) body of the entry.
- **Tags** - type a word and press Enter to add it as a tag; existing tags
  are suggested as you type. Fully free-form - Andre can invent new tags any
  time, there's no fixed list to pick from (a starter set is preloaded so
  he isn't starting from nothing).
- **Photos** - tap **Add Photo** to attach one or more.

Tap **Save Note** - the entry is saved to the phone instantly and
starts syncing to the server in the background (see
[chapter 5](#5-how-offline-capture-works)).

### Dashboard

A quick at-a-glance view: total entries, entries this week, how many have
photos, how many tags are in use, a breakdown of entry counts per tag, and
the most recent entries.

### Entries

Search by title, notes text, or block/location, and/or filter by a single
tag. Tap any entry to open its full detail - photos, tags, block, and full
notes text.

### Editing and archiving

From an entry's detail view: **Edit** reopens it in the Capture form with
everything filled in; **Archive** soft-deletes it (it stops appearing in
lists, but nothing is actually erased from the database - there is
currently no in-app "restore an archived entry" option, so archive is meant
for genuine mistakes, not routine cleanup).

---

## 5. How Offline Capture Works

Every **Save Note** writes the entry (and any attached photos)
straight into the phone's own local storage first - this always succeeds
instantly, with or without a signal. A background sync process then:

1. Checks the phone actually has a connection.
2. Sends any not-yet-synced entries to the server.
3. Only once an entry is confirmed saved on the server, sends its photos
   (this order matters - the server needs to know about the entry before it
   can accept a photo for it).
4. Retries automatically every ~10 seconds, and immediately whenever the
   phone regains a connection - nothing needs to be triggered manually.

### Location and weather on a note

Opening the **Capture** tab starts the phone looking for a GPS fix, and the
line above the Save button says whether one is ready. Saving never waits for
it - if no fix has arrived, the note simply saves without one.

The two behave differently out of signal, and deliberately so:

- **Location** still works. GPS is the phone's own receiver and needs no
  connection, so a note taken in the furthest block still records where it
  was taken.
- **Weather** does not. It is looked up through the farm server at the moment
  of capture, so with no connection the note keeps its location and leaves the
  weather blank. It is **not** filled in later when the note syncs: that would
  record the weather hours after the fact - on a note about sunburn or frost,
  actively misleading. A blank weather reading means "we don't know", and
  that is the honest answer.

Tapping the coordinates on a saved note opens them in the phone's map app,
which is the practical point of recording them - being able to walk back to
that exact tree next season.

### The "not yet synced" badge

If anything is still waiting to sync, a small badge appears near the top of
the screen (e.g. "2 not yet synced"). This is the only signal that
something hasn't reached the server yet - it's normal to see it briefly
after saving an entry with no signal, and it should clear on its own once
back in range. If it persists for a long time despite having a good
connection, check [Troubleshooting](#7-troubleshooting--faq).

### A real risk to know about: iOS storage eviction

If the installed app goes completely unused for roughly a week or more, iOS
can silently clear its local storage to free up space - including anything
still waiting to sync. This is exactly why the sync happens automatically
and quickly (every ~10 seconds whenever online) rather than waiting for
Andre to manually "upload" - the safest habit is simply opening the app
again with a signal reasonably soon after a batch of offline captures,
rather than leaving unsynced entries sitting for days.

---

## 6. Backups & Restore

A full backup (database + all photos) is taken **automatically every day at
02:00**, keeping the **14 most recent** backups on the server - same
mechanism as Boord. This only runs if the server is actually
running at 02:00; if the PC is off overnight, that night's backup is simply
skipped.

Anyone using the app can also trigger
one on demand from the **Settings** tab: the **Backups** card has a
**Backup Now** button, plus a list of existing backups with a **Download**
link for each - useful for pulling a copy off the server onto a phone or
laptop without needing to touch the server itself. On the server, the
underlying files sit in `data\backups\`, named like
`backup_20260807_020000.zip`.

**Recommended:** every so often, copy the latest `data\backups\*.zip` file
off the server entirely (a cloud drive, USB stick, anywhere off that one
machine) - the 14-backup retention only protects against recent mistakes,
not against that PC's disk failing outright.

### Restoring

There's no restore button - it's a manual file swap, and it fully replaces
current data (anything captured after the backup's timestamp is lost):

1. First, copy the *current* `data\notebook.db` and `data\photos\` folder
   somewhere safe, in case the restore turns out to be the wrong call.
2. Stop the server: `schtasks /end /tn "Boord Notes Server"`.
3. Unzip the backup - it contains `notebook.db` and a `photos\` folder.
4. Copy those into `data\`, replacing the current files.
5. Start the server again:
   `schtasks /run /tn "Boord Notes Server"`.

---

## 7. Troubleshooting / FAQ

**"Not yet synced" badge won't clear, even with good signal.**
Force-close the app (swipe it away in the iOS app switcher) and reopen it
from the Home Screen icon - this restarts the sync loop cleanly. If it
still won't clear, confirm the phone can actually reach the server's
address in Safari (try loading it directly); a changed server IP or an
expired Tailscale connection are the most likely causes.

**A camera photo won't attach / the Add Photo button does nothing.**
Confirm the app was opened from its installed Home Screen icon over the
HTTPS/Tailscale address - camera access in an installed PWA needs the
secure-context HTTPS setup described in
[chapter 2](#tailscale-https-required-for-the-installable-offline-app).

**Notes aren't recording a location.** The line above the Save button says
what the app has: "Finding your location..." means it's still looking, and
"No location available" means iOS refused or there's no fix. Check, in order:

1. The app was opened from its Home Screen icon on the HTTPS address
   (`https://<server-name>.<tailnet-name>.ts.net:9443/app/`). On anything
   that is not a secure origin iOS blocks location outright and the app can
   only report that none arrived - the commonest cause, and it looks like a
   broken feature rather than a wrong address.
2. Settings → Privacy & Security → Location Services is on, and the app (or
   Safari) is allowed "While Using".
3. He's outdoors and has waited a few seconds - a first fix under a shed roof
   can take a while, or never arrive.

A note always saves regardless; it just saves without coordinates.

**Notes have a location but no weather.** Expected when the note was captured
out of signal. The weather is read at the moment of capture and deliberately
not backfilled later, because that would record conditions hours after the
fact. Blank means "not known".

**Dictation isn't picking up Afrikaans / keeps typing in the wrong
language.** On the iPhone: Settings → General → Keyboard → Keyboards →
confirm both the desired language keyboards are added; iOS dictation
follows whichever keyboard is currently active, switchable with the globe
key while typing.

**The app opens but everything fails, on the old `:8443` address.** This is
the one migration trap in the move to `:9443`. Until this release the manual
put this app on `:8443`, which is Boord Owner's port. A phone whose Home
Screen icon still points at `https://<server>.<tailnet>.ts.net:8443/app/` now
reaches *Boord Owner's* server - and because this app's offline shell is
still cached against that address, it will happily draw the Boord Notes UI
from cache while every request behind it fails.

The symptom is therefore an app that looks completely normal and can do
nothing. Fixing it on the phone takes both halves:

1. Delete the old Home Screen icon.
2. Safari → Settings → Advanced → Website Data, find the server's name, and
   remove it. This is what clears the stale offline copy; deleting the icon
   alone does not.
3. Re-add the icon from the new address, `.../:9443/app/`.

**An entry looks like it disappeared after installing the Home Screen
icon.** This is the iOS storage-silo issue described in
[chapter 3](#install-to-home-screen-before-first-use---this-matters) - it
was captured in a Safari tab before installing, and is sitting in Safari's
own storage, invisible to the installed app. There's no way to move it
across after the fact; re-enter it from the installed app going forward.

---

## Annexe A: Data Field Reference

### Entry
- `id` - a random ID generated on the phone at creation time (this is what
  makes offline sync safe to retry - resending the same entry twice never
  creates a duplicate).
- `title`, `body` (the notes text), `block` (free text).
- `tags` - any number of free-form tags.
- `photos` - any number of attached photos.
- `created_by` / `created_at`, `updated_by` / `updated_at`.
- `archived` - true once soft-deleted; archived entries are hidden from
  search/lists but not erased.
- `latitude`, `longitude`, `location_accuracy_m` - where the phone was when
  the note was captured, from its own GPS. Blank if the fix wasn't ready yet
  or location permission was refused.
- `weather_temp`, `weather_humidity`, `weather_condition` - the conditions at
  that spot at that moment. Blank when the note was captured out of signal.
  Blank always means "not known", never "nothing to report".

Both sets are recorded **once, when the note is first created**, and a later
edit never changes them: they describe a moment that has already happened, so
fixing a typo that evening must not restamp the note with the kitchen's
coordinates and tonight's weather.

### Tag
Just a `name` - created automatically the first time anyone uses it on an
entry, shared across all entries.

### Photo
`filename` (on the server, under `data\photos\`), `caption` (currently
always blank - no UI to set one yet), the entry it belongs to, and when it
was uploaded.
