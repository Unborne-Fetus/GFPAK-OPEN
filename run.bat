@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ========================================================
echo  GFPAK OPEN - BUILD AND LAUNCH PORTABLE WINDOWS EXE
echo ========================================================
echo  Output: %CD%\dist\GFPAK-OPEN.exe
echo  No installer is created. The EXE runs directly.
echo.

where py >nul 2>&1
if %ERRORLEVEL%==0 (
    set "PYTHON=py -3"
) else (
    set "PYTHON=python"
)

%PYTHON% --version
if errorlevel 1 goto :missing_python

where npm >nul 2>&1
if errorlevel 1 goto :missing_node

echo [1/3] Preparing portable desktop build tools...
%PYTHON% -m pip install --disable-pip-version-check pyinstaller pywebview pyooz==0.0.8 "cryptography>=44,<48" "zstandard>=0.23,<1" "lz4>=4,<5"
if errorlevel 1 goto :failed

echo [2/3] Building bundled offline 3D studio...
rem Always synchronize JavaScript dependencies. Checking only for Vite misses
rem newly added packages (for example ooz-wasm) in an older node_modules.
call npm install --prefer-offline --no-audit --no-fund
if errorlevel 1 goto :failed
if not exist "node_modules\ooz-wasm\package.json" (
    echo ERROR: The required ooz-wasm decoder was not installed.
    goto :failed
)
set "GFPAK_DESKTOP=1"
call npm run build
if errorlevel 1 goto :failed
if not exist "dist-desktop\index.html" goto :failed

echo [3/3] Creating standalone GFPAK-OPEN.exe...
%PYTHON% -m PyInstaller --noconfirm --onefile --windowed --name GFPAK-OPEN --collect-all webview --collect-all cryptography --collect-all zstandard --collect-all lz4 --hidden-import ooz --add-data "dist-desktop;web_dist" launch.py
if errorlevel 1 goto :failed
if not exist "dist\GFPAK-OPEN.exe" goto :failed

echo.
echo ========================================================
echo  SUCCESS - PORTABLE APPLICATION CREATED
echo  %CD%\dist\GFPAK-OPEN.exe
echo ========================================================
echo  Run or copy this EXE. It is not an installer.
echo  Model previews and exports use the built-in decoders.
echo.
if /I "%~1"=="--build-only" exit /b 0
start "" "%CD%\dist\GFPAK-OPEN.exe"
exit /b 0

:missing_python
echo ERROR: Python 3 is required to build the portable EXE.
goto :failed

:missing_node
echo ERROR: Install Node.js LTS to build the bundled studio.
goto :failed

:failed
echo.
echo GFPAK OPEN BUILD FAILED. No working EXE was confirmed.
pause
exit /b 1
