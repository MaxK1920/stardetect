@echo off
REM ===========================================================================
REM  StarDetect launcher
REM  Double-click to start the app. On first run (or on a fresh machine) it
REM  checks for Node.js, Python and FFmpeg, installs the Node + Python
REM  dependencies if they are missing, then launches StarDetect.
REM ===========================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title StarDetect

echo ===========================================================
echo                      StarDetect
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
REM  1. Node.js  (required - provides Electron + npm)
REM ---------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js was not found.
  call :winget_install "OpenJS.NodeJS.LTS" "Node.js LTS"
  echo.
  echo     Node.js was just installed. Close this window and double-click
  echo     StarDetect.bat again so the new PATH takes effect.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo [ok] Node.js %%v

REM ---------------------------------------------------------------------------
REM  2. Python  (required - runs the detection / export backend)
REM ---------------------------------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
  echo [!] Python was not found.
  call :winget_install "Python.Python.3.12" "Python 3.12"
  echo.
  echo     Python was just installed. Close this window and double-click
  echo     StarDetect.bat again so the new PATH takes effect.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('python --version') do echo [ok] %%v

REM ---------------------------------------------------------------------------
REM  3. FFmpeg  (optional - needed only for video/audio export)
REM ---------------------------------------------------------------------------
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [!] FFmpeg not found - video export will be disabled until it is installed.
  call :winget_install "Gyan.FFmpeg" "FFmpeg"
  echo     ^(If it was just installed, restart this launcher to enable export.^)
) else (
  echo [ok] FFmpeg found
)

echo.

REM ---------------------------------------------------------------------------
REM  4. Node dependencies (Electron, etc.)
REM ---------------------------------------------------------------------------
if not exist "node_modules\electron" (
  echo [*] Installing Node dependencies - this can take a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo [X] "npm install" failed. Check your internet connection and the
    echo     messages above, then run StarDetect.bat again.
    echo.
    pause
    exit /b 1
  )
) else (
  echo [ok] Node dependencies present
)

REM  Verify the Electron binary - npm install reports success even when the
REM  binary download step fails, leaving a broken node_modules\electron folder.
if not exist "node_modules\electron\dist\electron.exe" (
  echo [!] Electron binary missing - attempting repair...
  echo.
  if exist "node_modules\electron" rmdir /s /q "node_modules\electron"
  call npm install electron
  set "ELECTRON_OK=0"
  if exist "node_modules\electron\install.js" (
    for /l %%A in (1,1,3) do (
      if "!ELECTRON_OK!"=="0" (
        echo [*] Downloading Electron binary ^(attempt %%A of 3^)...
        node node_modules\electron\install.js
        if exist "node_modules\electron\dist\electron.exe" set "ELECTRON_OK=1"
        if "!ELECTRON_OK!"=="0" if %%A LSS 3 (
          echo [!] Retrying in 5 seconds...
          timeout /t 5 /nobreak >nul
        )
      )
    )
  )
  if "!ELECTRON_OK!"=="0" (
    echo.
    echo [X] Could not download the Electron binary after 3 attempts.
    echo     This is almost always a network issue ^(firewall / slow connection^).
    echo.
    echo     Manual fix:
    echo       1. Download this file on any PC with working internet:
    echo          https://github.com/electron/electron/releases/download/v31.7.7/electron-v31.7.7-win32-x64.zip
    echo       2. Extract the zip contents into:
    echo          %CD%\node_modules\electron\dist\
    echo       3. Run StarDetect.bat again.
    echo.
    pause
    exit /b 1
  )
  echo [ok] Electron installed.
  echo.
)

REM ---------------------------------------------------------------------------
REM  5. Python backend dependencies
REM     Core: numpy, Pillow, opencv. YOLO engine: ultralytics ^(pulls torch^).
REM     Without ultralytics the app still runs in synthetic FALLBACK mode.
REM ---------------------------------------------------------------------------
python -c "import numpy, PIL, cv2" 1>nul 2>nul
if errorlevel 1 (
  echo [*] Installing Python backend dependencies...
  python -m pip install --upgrade pip
  python -m pip install -r backend\requirements.txt
  if errorlevel 1 (
    echo.
    echo [X] Installing Python dependencies failed. See messages above.
    echo.
    pause
    exit /b 1
  )
) else (
  echo [ok] Python backend dependencies present
  python -c "import ultralytics" 1>nul 2>nul
  if errorlevel 1 (
    echo [*] Installing YOLO engine ^(ultralytics + torch^) - large download, please wait...
    python -m pip install -r backend\requirements.txt
  )
)

echo.
echo [*] Launching StarDetect...
echo.

REM Electron refuses to start when NODE_OPTIONS contains flags it does not
REM understand (e.g. --use-system-ca used for npm behind a proxy). Clear it
REM for the launch only; npm install above still saw the original value.
set "NODE_OPTIONS="
call npx electron .

echo.
echo StarDetect has closed.
pause
exit /b 0

REM ===========================================================================
REM  Helper: install a package via winget if winget is available.
REM   %~1 = winget package id   %~2 = friendly name
REM ===========================================================================
:winget_install
where winget >nul 2>nul
if errorlevel 1 (
  echo     winget is not available on this system. Please install %~2 manually:
  echo       Node.js : https://nodejs.org
  echo       Python  : https://www.python.org/downloads
  echo       FFmpeg  : https://ffmpeg.org/download.html
  goto :eof
)
echo     Installing %~2 via winget...
winget install -e --id %~1 --accept-source-agreements --accept-package-agreements
goto :eof
