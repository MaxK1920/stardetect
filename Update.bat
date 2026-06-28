@echo off
REM ===========================================================================
REM  StarDetect  -  Update via Git
REM  Run this to pull the latest version from the remote and refresh deps.
REM  Requirements: Git must be installed and the app must have been installed
REM  by cloning its Git repository (not by extracting a zip).
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title StarDetect - Updater

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
REM  2. Is this a Git repository?
REM ---------------------------------------------------------------------------
if not exist ".git" (
  echo.
  echo [X] This folder is not a Git repository.
  echo.
  echo     Auto-update only works when the app was installed via git clone.
  echo     If you downloaded a zip, delete this folder and clone instead:
  echo.
  echo       git clone ^<repository-url^> StarDetect
  echo.
  pause
  exit /b 1
)

REM ---------------------------------------------------------------------------
REM  3. Save current HEAD so we can compare after the pull
REM ---------------------------------------------------------------------------
for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "HEAD_BEFORE=%%h"
if "!HEAD_BEFORE!"=="" (
  echo [X] Could not read current Git commit. Repository may be corrupt.
  pause
  exit /b 1
)
echo [*] Current version : !HEAD_BEFORE:~0,7!

REM ---------------------------------------------------------------------------
REM  4. Pull
REM ---------------------------------------------------------------------------
echo.
echo [*] Checking for updates...
echo.
git pull --ff-only
if errorlevel 1 (
  echo.
  echo [X] git pull failed. Common causes:
  echo.
  echo     - No internet connection.
  echo     - No remote configured. Fix with:
  echo         git remote add origin ^<repository-url^>
  echo     - Local uncommitted changes conflict with incoming changes.
  echo         Run "git status" to inspect.
  echo     - Non-fast-forward history ^(someone force-pushed^).
  echo         Run "git fetch origin" then "git reset --hard origin/main"
  echo         ^(WARNING: discards any local changes^).
  echo.
  pause
  exit /b 1
)

REM ---------------------------------------------------------------------------
REM  5. Compare HEAD before and after
REM ---------------------------------------------------------------------------
for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "HEAD_AFTER=%%h"

if "!HEAD_BEFORE!"=="!HEAD_AFTER!" (
  echo.
  echo [ok] Already up to date ^(!HEAD_AFTER:~0,7!^) - nothing to do.
  echo.
  goto :launch_prompt
)

echo.
echo [ok] Updated  !HEAD_BEFORE:~0,7!  --^>  !HEAD_AFTER:~0,7!
echo.

REM ---------------------------------------------------------------------------
REM  6. Detect which files changed so we only re-install what is needed
REM ---------------------------------------------------------------------------
git diff --name-only "!HEAD_BEFORE!" "!HEAD_AFTER!" >"%TEMP%\sd_update_changed.txt" 2>nul

set "NEED_NPM=0"
set "NEED_PIP=0"

findstr /i "^package" "%TEMP%\sd_update_changed.txt" >nul 2>nul
if not errorlevel 1 set "NEED_NPM=1"

findstr /i "^backend/requirements" "%TEMP%\sd_update_changed.txt" >nul 2>nul
if not errorlevel 1 set "NEED_PIP=1"

del "%TEMP%\sd_update_changed.txt" >nul 2>nul

REM ---------------------------------------------------------------------------
REM  7. Refresh Node dependencies (only when package.json / lock changed)
REM ---------------------------------------------------------------------------
if "!NEED_NPM!"=="1" (
  echo [*] package.json changed - refreshing Node dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo [X] npm install failed. Check the messages above.
    echo.
    pause
    exit /b 1
  )
  echo [ok] Node dependencies updated.
  echo.
) else (
  echo [ok] Node dependencies - no change.
)

REM ---------------------------------------------------------------------------
REM  8. Refresh Python dependencies (only when requirements.txt changed)
REM ---------------------------------------------------------------------------
if "!NEED_PIP!"=="1" (
  echo [*] requirements.txt changed - refreshing Python dependencies...
  python -m pip install -r backend\requirements.txt
  if errorlevel 1 (
    echo.
    echo [X] pip install failed. Check the messages above.
    echo.
    pause
    exit /b 1
  )
  echo [ok] Python dependencies updated.
  echo.
) else (
  echo [ok] Python dependencies - no change.
)

echo.
echo ===========================================================
echo  Update complete!
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
