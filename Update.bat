@echo off
REM ===========================================================================
REM  StarDetect  -  Update via Git
REM  Run this to pull the latest version and refresh dependencies.
REM  Works whether you cloned the repo or downloaded it as a zip.
REM  Requirements: Git must be installed (https://git-scm.com/downloads).
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title StarDetect - Updater

REM ---------------------------------------------------------------------------
REM  Repository URL  (change this if the repo moves)
REM ---------------------------------------------------------------------------
set "REPO_URL=https://github.com/MaxK1920/stardetect.git"

echo ===========================================================
echo               StarDetect  -  Updater
echo ===========================================================
echo.

if not exist "package.json" (
  echo [X] This script must live in the StarDetect project folder
  echo     ^(next to package.json^). Current folder: %CD%
  echo.
  pause
  exit /b 1
)

REM ---------------------------------------------------------------------------
REM  1. Git installed?
REM ---------------------------------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
  echo [X] Git is not installed or not on PATH.
  echo.
  echo     Install Git from: https://git-scm.com/downloads
  echo     After installing, close this window and run Update.bat again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('git --version') do echo [ok] %%v

REM ---------------------------------------------------------------------------
REM  2. Link to Git repository (initialize if this was downloaded as a zip)
REM ---------------------------------------------------------------------------
set "FIRST_INSTALL=0"
if not exist ".git" (
  echo.
  echo [!] No Git repository found - this looks like a zip download.
  echo     Linking to the StarDetect repository so updates will work...
  echo.
  git init
  git remote add origin %REPO_URL%
  if errorlevel 1 (
    echo [X] Failed to link the repository. Check your internet connection.
    pause
    exit /b 1
  )
  echo [ok] Linked to %REPO_URL%
  echo.
  set "FIRST_INSTALL=1"
)

REM ---------------------------------------------------------------------------
REM  3. Save current HEAD (empty on first install, that is fine)
REM ---------------------------------------------------------------------------
for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "HEAD_BEFORE=%%h"
if "!FIRST_INSTALL!"=="0" (
  if "!HEAD_BEFORE!"=="" (
    echo [X] Could not read current Git commit. Repository may be corrupt.
    pause
    exit /b 1
  )
  echo [*] Current version : !HEAD_BEFORE:~0,7!
)

REM ---------------------------------------------------------------------------
REM  4. Fetch / pull
REM ---------------------------------------------------------------------------
echo.
if "!FIRST_INSTALL!"=="1" (
  echo [*] Downloading StarDetect from GitHub...
  echo.
  git fetch origin
  if errorlevel 1 (
    echo.
    echo [X] Download failed. Check your internet connection.
    echo.
    pause
    exit /b 1
  )
  git reset --hard origin/main
  if errorlevel 1 (
    echo.
    echo [X] Failed to apply downloaded files.
    echo.
    pause
    exit /b 1
  )
) else (
  echo [*] Checking for updates...
  echo.
  git pull --ff-only
  if errorlevel 1 (
    echo.
    echo [X] git pull failed. Common causes:
    echo.
    echo     - No internet connection.
    echo     - Local uncommitted changes conflict with incoming changes.
    echo         Run "git status" to inspect.
    echo     - Non-fast-forward history ^(someone force-pushed^).
    echo         Run "git fetch origin" then "git reset --hard origin/main"
    echo         ^(WARNING: discards any local changes^).
    echo.
    pause
    exit /b 1
  )
)

REM ---------------------------------------------------------------------------
REM  5. Compare HEAD before and after
REM ---------------------------------------------------------------------------
for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "HEAD_AFTER=%%h"

if "!FIRST_INSTALL!"=="0" (
  if "!HEAD_BEFORE!"=="!HEAD_AFTER!" (
    echo.
    echo [ok] Already up to date ^(!HEAD_AFTER:~0,7!^) - nothing to do.
    echo.
    goto :launch_prompt
  )
  echo.
  echo [ok] Updated  !HEAD_BEFORE:~0,7!  --^>  !HEAD_AFTER:~0,7!
  echo.
) else (
  echo.
  echo [ok] Downloaded version !HEAD_AFTER:~0,7!
  echo.
)

REM ---------------------------------------------------------------------------
REM  6. Detect which files changed (always install all deps on first install)
REM ---------------------------------------------------------------------------
set "NEED_NPM=0"
set "NEED_PIP=0"

if "!FIRST_INSTALL!"=="1" (
  set "NEED_NPM=1"
  set "NEED_PIP=1"
) else (
  git diff --name-only "!HEAD_BEFORE!" "!HEAD_AFTER!" >"%TEMP%\sd_update_changed.txt" 2>nul
  findstr /i "^package" "%TEMP%\sd_update_changed.txt" >nul 2>nul
  if not errorlevel 1 set "NEED_NPM=1"
  findstr /i "^backend/requirements" "%TEMP%\sd_update_changed.txt" >nul 2>nul
  if not errorlevel 1 set "NEED_PIP=1"
  del "%TEMP%\sd_update_changed.txt" >nul 2>nul
)

REM ---------------------------------------------------------------------------
REM  7. Refresh Node dependencies
REM ---------------------------------------------------------------------------
if "!NEED_NPM!"=="1" (
  echo [*] Installing Node dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo [X] npm install failed. Check the messages above.
    echo.
    pause
    exit /b 1
  )
  echo [ok] Node dependencies installed.
  echo.
) else (
  echo [ok] Node dependencies - no change.
)

REM ---------------------------------------------------------------------------
REM  7b. Verify Electron binary (postinstall download often fails silently)
REM ---------------------------------------------------------------------------
if not exist "node_modules\electron\dist\electron.exe" (
  echo [!] Electron binary is missing ^(the download likely failed during npm install^).
  echo     Removing and re-downloading Electron...
  echo.
  if exist "node_modules\electron" rmdir /s /q "node_modules\electron"
  call npm install electron
  if errorlevel 1 (
    echo.
    echo [X] Electron reinstall failed. Check your internet connection and try again.
    echo.
    pause
    exit /b 1
  )
  if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo [X] Electron binary still missing after reinstall.
    echo     Try running  npm install  manually in the project folder,
    echo     or check https://github.com/electron/electron for known issues.
    echo.
    pause
    exit /b 1
  )
  echo [ok] Electron installed successfully.
  echo.
)

REM ---------------------------------------------------------------------------
REM  8. Refresh Python dependencies
REM ---------------------------------------------------------------------------
if "!NEED_PIP!"=="1" (
  echo [*] Installing Python dependencies...
  python -m pip install -r backend\requirements.txt
  if errorlevel 1 (
    echo.
    echo [X] pip install failed. Check the messages above.
    echo.
    pause
    exit /b 1
  )
  echo [ok] Python dependencies installed.
  echo.
) else (
  echo [ok] Python dependencies - no change.
)

echo.
echo ===========================================================
if "!FIRST_INSTALL!"=="1" (
  echo  Installation complete!
) else (
  echo  Update complete!
)
echo ===========================================================
echo.

REM ---------------------------------------------------------------------------
REM  9. Offer to launch the app
REM ---------------------------------------------------------------------------
:launch_prompt
set /p "CHOICE=Launch StarDetect now? [Y/n] : "
if /i "!CHOICE!"=="n"  goto :done
if /i "!CHOICE!"=="no" goto :done

echo.
echo [*] Launching StarDetect...
echo.
set "NODE_OPTIONS="
call npx electron .

:done
echo.
pause
exit /b 0
