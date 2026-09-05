# Boord Notes - Windows server installer
#
# Sets up the Notes service to run beside Boord and Boord Owner on the same
# PC: installs Python if needed, creates the virtual environment, installs
# dependencies, writes the launcher, closes the firewall port older versions
# opened, and registers the service to auto-start at boot as SYSTEM. Safe to
# re-run - each step checks what is already done.
#
# Run via install.bat, which handles the administrator-elevation prompt.

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$BackendDir = Join-Path $RepoRoot "backend"
$VenvDir = Join-Path $BackendDir ".venv"
$DataDir = Join-Path $RepoRoot "data"
# 8020 continues the family's numbering on this machine: Boord 8000, Boord
# Owner 8010, Boord Notes 8020. See step 10 for the Tailscale side, where the
# three are 443, 8443 and 9443 - that is the part that actually collides.
$Port = 8020
$TailscaleHttpsPort = 9443
$TaskName = "Boord Notes Server"
$FirewallRuleName = "Boord Notes Server"
$PythonVersion = "3.11.9"
$PythonInstallerUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"
$LauncherPath = Join-Path $RepoRoot "start_notes_server.bat"
$LegacyLauncherPath = Join-Path $RepoRoot "start_server.bat"
$LegacyTaskName = "Bekfontein Farm Notebook Server"
$LegacyFirewallRuleName = "Bekfontein Farm Notebook Server"
$ReleaseKeyPath = Join-Path $RepoRoot "release-key.asc"
$FprFile = Join-Path $DataDir "release_key.fpr"

function Write-Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "    $m" -ForegroundColor Red }

function Test-PythonOk($exe) {
    if (-not $exe -or -not (Test-Path $exe)) { return $false }
    try {
        $out = & $exe -c "import sys; print(sys.version_info[0]); print(sys.version_info[1]); print('64BIT' if sys.maxsize > 2**32 else '32BIT')" 2>$null
        if (-not $out -or $out.Count -lt 3) { return $false }
        return ([int]$out[0] -eq 3 -and [int]$out[1] -ge 9 -and $out[2].Trim() -eq "64BIT")
    } catch { return $false }
}

try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Err "This script needs to run as Administrator."
        Write-Err "Please run install.bat instead of this file directly - it handles that automatically."
        exit 1
    }

    Write-Host ""
    Write-Host "Boord Notes - Server Installer" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan

    # data\ is gitignored, so a fresh clone arrives without one. The server
    # creates it on first start, but the release_key.fpr command printed at
    # the end has to work even on a run where the server did not come up -
    # otherwise the one manual step left fails with "The system cannot find
    # the path specified" and looks like a broken installer.
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }

    # --- Step 1: Find or install Python ---
    Write-Step "Checking for Python 3.9+ (64-bit)..."
    $pythonExe = $null

    $existing = Get-Command python -ErrorAction SilentlyContinue
    if ($existing -and (Test-PythonOk $existing.Source)) {
        $pythonExe = $existing.Source
        Write-Ok "Found a compatible Python at $pythonExe"
    } else {
        $wellKnownPath = Join-Path $env:ProgramFiles "Python311\python.exe"
        if (Test-PythonOk $wellKnownPath) {
            $pythonExe = $wellKnownPath
            Write-Ok "Found a compatible Python at $pythonExe"
        } else {
            Write-Warn "No compatible 64-bit Python 3.9+ found - downloading Python $PythonVersion..."
            $installerPath = Join-Path $env:TEMP "python-$PythonVersion-amd64.exe"
            Invoke-WebRequest -Uri $PythonInstallerUrl -OutFile $installerPath -UseBasicParsing
            Write-Warn "Installing Python (this can take a minute)..."
            Start-Process -FilePath $installerPath -ArgumentList "/quiet InstallAllUsers=1 PrependPath=1 Include_test=0" -Wait
            Remove-Item $installerPath -ErrorAction SilentlyContinue
            $pythonExe = $wellKnownPath
            if (-not (Test-PythonOk $pythonExe)) {
                Write-Err "Python installation could not be confirmed at $pythonExe."
                Write-Err "Please install Python 3.9+ (64-bit) manually from python.org and re-run this installer."
                exit 1
            }
            Write-Ok "Installed Python at $pythonExe"
        }
    }

    # --- Step 2: Git and GnuPG (both only needed by update_server.bat) ---
    #
    # Neither is required to RUN the server, so nothing here is fatal - a farm
    # that cannot update is still a farm that works. They are checked at
    # install time anyway because the alternative is finding out months later,
    # in the middle of wanting an update.
    Write-Step "Checking for Git..."
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Ok "Found Git"
    } else {
        Write-Warn "Git is not installed. The server will still run, but update_server.bat"
        Write-Warn "cannot fetch updates without it. Get it from https://git-scm.com/download/win"
    }

    # Updates are signed-tag only (see update_server.bat), so the update path
    # needs a working gpg. Git for Windows bundles one, but it keeps keys in a
    # keyboxd daemon the Git distribution does not ship, so it fails exactly
    # like a bad signature does - which sends people looking for an attacker
    # instead of an installer. Reject it by path, same as Boord does.
    Write-Step "Checking for GnuPG (used to verify signed releases)..."
    $gpgExe = $null
    $gpgCmd = Get-Command gpg -ErrorAction SilentlyContinue
    if ($gpgCmd -and $gpgCmd.Source -notlike "*\Git\usr\bin\*") {
        $gpgExe = $gpgCmd.Source
        Write-Ok "Found GnuPG at $gpgExe"
    } else {
        foreach ($candidate in @((Join-Path $env:ProgramFiles "GnuPG\bin\gpg.exe"),
                                 (Join-Path ${env:ProgramFiles(x86)} "GnuPG\bin\gpg.exe"))) {
            if ((Test-Path $candidate) -and -not $gpgExe) { $gpgExe = $candidate }
        }
        if ($gpgExe) {
            Write-Ok "Found GnuPG at $gpgExe"
        } else {
            Write-Warn "GnuPG not found. The server runs fine without it, but"
            Write-Warn "update_server.bat cannot verify a release and will refuse to"
            Write-Warn "install one. Boord's own install.bat installs Gpg4win and points git"
            Write-Warn "at it - if this PC runs Boord, run that once and this is handled."
            Write-Warn "Otherwise: https://gpg4win.org"
        }
    }

    # Importing the public key from the repo is safe: what actually decides
    # which releases are trusted is the fingerprint in data\release_key.fpr,
    # which lives outside the repo. A swapped key would not match it and
    # update_server.bat would refuse the release.
    if ($gpgExe -and (Test-Path $ReleaseKeyPath)) {
        try {
            # Not -Wait, and time-limited. GnuPG starts keyboxd and gpg-agent on
            # its first run, and on a machine whose keyring has just been created
            # that start-up can hang indefinitely with its output redirected into
            # a non-interactive process. Importing the key is a convenience; it
            # must never be able to block the install.
            $gpgLog = Join-Path $env:TEMP "boord-notes-gpg-import.log"
            $proc = Start-Process -FilePath $gpgExe `
                -ArgumentList @("--batch", "--yes", "--import", $ReleaseKeyPath) `
                -NoNewWindow -PassThru `
                -RedirectStandardError $gpgLog -RedirectStandardOutput "$gpgLog.out"
            try { $null = $proc.Handle } catch { }
            if ($proc.WaitForExit(60000)) {
                $exit = $null
                try { $exit = $proc.ExitCode } catch { }
                if ($exit -eq 0) { Write-Ok "Imported the release key" }
                else { Write-Warn "Importing release-key.asc did not report success - see $gpgLog" }
            } else {
                try { $proc.Kill() } catch { }
                Write-Warn "gpg did not finish within 60 seconds - skipped the key import."
                Write-Warn "Run this once in a Command Prompt, which lets it finish:"
                Write-Warn "    ""$gpgExe"" --import release-key.asc"
            }
            Remove-Item "$gpgLog.out" -ErrorAction SilentlyContinue
        } catch {
            Write-Warn "Could not import release-key.asc: $($_.Exception.Message)"
        }
    }

    # --- Step 3: Create the virtual environment ---
    Write-Step "Setting up the app's virtual environment..."
    if (-not (Test-Path $VenvDir)) {
        & $pythonExe -m venv $VenvDir
        Write-Ok "Created virtual environment"
    } else {
        Write-Ok "Virtual environment already exists"
    }
    $venvPython = Join-Path $VenvDir "Scripts\python.exe"
    # Deliberately NOT $VenvDir\Scripts\pip.exe. That is a launcher stub
    # generated when the venv is created - a brand-new unsigned executable,
    # which Windows Application Control (Smart App Control / WDAC / AppLocker)
    # blocks outright on a machine that enforces one. The venv's python.exe is
    # a COPY of the Python Software Foundation binary and keeps its
    # Authenticode signature, so `python -m pip` runs where `pip.exe` cannot.

    # --- Step 4: Install dependencies ---
    Write-Step "Installing app dependencies (this can take a few minutes on first run)..."
    & $venvPython -m pip install --quiet --disable-pip-version-check -r (Join-Path $BackendDir "requirements.txt")
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Dependency install failed."
        Write-Err "Usually this is no internet, or pip being blocked by a proxy."
        Write-Err "If the error above mentions an Application Control policy, this PC"
        Write-Err "enforces one and has blocked a binary inside .venv. Nothing here"
        Write-Err "needs the policy relaxed - tell whoever manages it which file was"
        Write-Err "blocked. Re-running this installer is safe; it reuses the venv."
        exit 1
    }
    Write-Ok "Dependencies installed"

    # --- Step 5: Write the launcher script ---
    Write-Step "Creating the server launcher..."
    # --host 127.0.0.1 is load-bearing, not a default, and it is a change from
    # how this app used to be deployed. The only way in is now `tailscale
    # serve`, which proxies to http://localhost:$Port and is reachable inside
    # the tailnet only. Widening this back to 0.0.0.0 would republish the app
    # to every device on the farm's wifi, behind nothing but the two seeded
    # passwords. It also matches Boord Owner, so the three apps on this PC are
    # reached one way rather than three.
    $launcherContent = @"
@echo off
cd /d "$BackendDir"
"$venvPython" -m uvicorn main:app --host 127.0.0.1 --port $Port
"@
    Set-Content -Path $LauncherPath -Value $launcherContent -Encoding ASCII
    Write-Ok "Created $LauncherPath"
    if (Test-Path $LegacyLauncherPath) {
        Remove-Item $LegacyLauncherPath -ErrorAction SilentlyContinue
        Write-Ok "Removed the old start_server.bat (it still bound 0.0.0.0)"
    }

    # --- Step 6: Firewall ---
    # Nothing to open: the server listens on loopback only, so no inbound rule
    # can reach it. This DELETES the rules older installers added - upgrading a
    # server that already had the port open to the LAN has to close it, or the
    # whole point of the loopback bind is lost on exactly the machines that
    # have been running longest. The old rule was named for the old app name,
    # so both names are cleared.
    Write-Step "Closing the firewall port older versions opened..."
    netsh advfirewall firewall delete rule name="$FirewallRuleName" | Out-Null
    netsh advfirewall firewall delete rule name="$LegacyFirewallRuleName" | Out-Null
    Write-Ok "Port $Port is not exposed to the network (reachable via Tailscale only)"

    # --- Step 7: Scheduled task (auto-start at boot, no login needed) ---
    # The task is renamed along with the app, so the one the old installer
    # registered has to go - otherwise the PC boots two copies of this server
    # and the second one dies on a port already in use.
    Write-Step "Registering the server to start automatically with Windows..."
    foreach ($name in @($LegacyTaskName, $TaskName)) {
        cmd /c "schtasks /query /tn ""$name"" >nul 2>&1"
        if ($LASTEXITCODE -eq 0) {
            cmd /c "schtasks /end /tn ""$name"" >nul 2>&1"
            Start-Sleep -Seconds 1
            schtasks /delete /tn "$name" /f | Out-Null
            if ($name -eq $LegacyTaskName) { Write-Ok "Removed the old '$LegacyTaskName' task" }
        }
    }
    schtasks /create /tn "$TaskName" /tr "`"$LauncherPath`"" /sc onstart /ru SYSTEM /rl highest /f | Out-Null
    Write-Ok "Scheduled task '$TaskName' registered (runs at every startup, no one needs to log in)"

    # --- Step 8: Start it now ---
    Write-Step "Starting the server now..."
    schtasks /run /tn "$TaskName" | Out-Null

    # --- Step 9: Confirm it answers ---
    $serverUp = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:$Port/app/" -UseBasicParsing -TimeoutSec 3
            if ($resp.StatusCode -eq 200) { $serverUp = $true; break }
        } catch { }
    }
    if ($serverUp) { Write-Ok "Server is up and answering on port $Port" }
    else {
        Write-Warn "The server did not answer on port $Port within 20 seconds."
        Write-Warn "Run start_notes_server.bat directly in a window - errors print there"
        Write-Warn "rather than being swallowed by the Scheduled Task."
    }

    # --- Step 10: Report the address and how to publish it ---
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host " Setup complete!" -ForegroundColor Green
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host " On this PC: http://localhost:$Port/"
    Write-Host ""
    Write-Host " From anywhere else, publish it over Tailscale:"
    Write-Host ""
    Write-Host "   `"C:\Program Files\Tailscale\tailscale.exe`" serve --bg --https=$TailscaleHttpsPort http://localhost:$Port/" -ForegroundColor Yellow
    Write-Host ""
    Write-Host " It then answers at https://<machine>.<tailnet>.ts.net:$TailscaleHttpsPort/ for anyone"
    Write-Host " on the tailnet, over HTTPS, with a real Let's Encrypt certificate"
    Write-Host " Tailscale renews itself. Needs HTTPS Certificates enabled for the"
    Write-Host " tailnet (admin console -> DNS)."
    Write-Host ""
    Write-Host " HTTPS is not optional for this app: installing it to a phone's Home" -ForegroundColor Yellow
    Write-Host " Screen, and the camera it uses for photos, both need a secure origin." -ForegroundColor Yellow
    Write-Host " A plain http://192.168.x.x address gives neither." -ForegroundColor Yellow
    Write-Host ""
    Write-Host " $TailscaleHttpsPort, because this machine runs all three apps and each needs its" -ForegroundColor Yellow
    Write-Host " own port. Boord takes 443 (its Field QR scanner has to be what the" -ForegroundColor Yellow
    Write-Host " bare address reaches), Boord Owner takes 8443, this app takes $TailscaleHttpsPort:" -ForegroundColor Yellow
    Write-Host "" -ForegroundColor Yellow
    Write-Host "   tailscale serve reset" -ForegroundColor Yellow
    Write-Host "   tailscale serve --bg --https=443  http://localhost:8000" -ForegroundColor Yellow
    Write-Host "   tailscale serve --bg --https=8443 http://localhost:8010" -ForegroundColor Yellow
    Write-Host "   tailscale serve --bg --https=$TailscaleHttpsPort http://localhost:$Port" -ForegroundColor Yellow
    Write-Host "" -ForegroundColor Yellow
    Write-Host " Two apps claiming one port is silent: the last command run wins and" -ForegroundColor Yellow
    # Single-quoted: a backslash is not an escape in PowerShell, so \" would end
    # the string here and the rest of the line would be parsed as extra
    # arguments to Write-Host.
    Write-Host ' the other app answers {"detail":"Not Found"}, which looks like' -ForegroundColor Yellow
    Write-Host " anything but a port clash. Check with: tailscale serve status" -ForegroundColor Yellow
    Write-Host ""
    Write-Warn "Use 'serve', NEVER 'funnel' - funnel would publish the farm's notes on"
    Write-Warn "the open internet to anyone who guessed the URL."
    Write-Host ""
    Write-Warn "Two accounts are seeded:"
    Write-Warn "  andre / ChangeMe123!  (recorder - can create and edit entries)"
    Write-Warn "  devin / ChangeMe123!  (viewer - read-only)"
    Write-Warn "Log in as each and change the password immediately under Settings -"
    Write-Warn "this installer does not do that step for you."
    Write-Host ""
    Write-Host " The server will now start automatically every time this PC turns on."
    Write-Host " update_server.bat installs the newest SIGNED release and restarts it."

    # --- Step 11: The trust root for updates ---
    #
    # Deliberately NOT written automatically. What this fingerprint decides is
    # which code this machine will accept in future, and this installer came
    # out of the very repository those updates come from - so a fingerprint it
    # wrote for you would be the repo vouching for itself. Typing it is the one
    # step that has to be a person's decision.
    #
    # Boord's own release_key.fpr is a different matter: it is outside this
    # repo and a human already put it there, for the same publisher and the
    # same key. Offering it saves the "where do I get the fingerprint" problem
    # without making the choice for anybody.
    if (-not (Test-Path $FprFile)) {
        $siblingFpr = $null
        foreach ($sibling in @("Boord", "BoordOwner")) {
            if ($siblingFpr) { continue }
            $candidate = Join-Path (Split-Path $RepoRoot -Parent) "$sibling\data\release_key.fpr"
            if (Test-Path $candidate) { $siblingFpr = (Get-Content $candidate -TotalCount 1).Trim() }
        }

        Write-Host ""
        Write-Host "================================================" -ForegroundColor Yellow
        Write-Host " One step left: trust the release key" -ForegroundColor Yellow
        Write-Host "================================================" -ForegroundColor Yellow
        Write-Host " update_server.bat will refuse to install anything until this server"
        Write-Host " knows which signing key to trust. The server you just installed runs"
        Write-Host " fine without this - only updates need it."
        Write-Host ""
        if ($siblingFpr) {
            Write-Host " Another Boord app on this PC already trusts this key. Same"
            Write-Host " publisher, same key - so in this folder, run:"
            Write-Host ""
            Write-Host "     >data\release_key.fpr echo $siblingFpr" -ForegroundColor Cyan
        } else {
            Write-Host " In this folder, run:"
            Write-Host ""
            Write-Host "     >data\release_key.fpr echo <FINGERPRINT>" -ForegroundColor Cyan
            Write-Host ""
            Write-Host " ...with the 40-character fingerprint from whoever maintains this"
            Write-Host " install."
        }
        Write-Host ""
        Write-Warn "Type it exactly as shown, redirect first. cmd reads a digit written"
        Write-Warn "immediately before a > as a file handle number, so the more natural"
        Write-Warn "'echo <FINGERPRINT>> file' quietly loses a fingerprint's last"
        Write-Warn "character whenever it happens to be a digit - and the update then"
        Write-Warn "fails the signature check, which looks like tampering rather than"
        Write-Warn "like a typo."
    } else {
        $fpr = (Get-Content $FprFile -TotalCount 1).Trim()
        Write-Ok "Release key fingerprint on file: $fpr"
    }
} catch {
    Write-Host ""
    Write-Err "Something went wrong:"
    Write-Err $_.Exception.Message
    Write-Err "See MANUAL.md chapter 2 for the manual step-by-step setup as a fallback."
    exit 1
}
