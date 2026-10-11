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

echo [1/4] Preparing portable desktop build tools...
%PYTHON% -m pip install --disable-pip-version-check pyinstaller pywebview pyooz==0.0.8 "cryptography>=44,<48" "zstandard>=0.23,<1"
if errorlevel 1 goto :failed

echo [2/4] Building bundled offline 3D studio...
if not exist "node_modules\vite" (
    call npm install --no-audit --no-fund
    if errorlevel 1 goto :failed
)
set "GFPAK_DESKTOP=1"
call npm run build
if errorlevel 1 goto :failed
if not exist "dist-desktop\index.html" goto :failed

echo [3/4] Bundling the Blender Python modules...
if not exist "build\blender_deps\flatbuffers\__init__.py" (
    if exist "build\blender_deps" rmdir /s /q "build\blender_deps"
    %PYTHON% -m pip install --disable-pip-version-check --only-binary=:all: --platform any --implementation py --python-version 3.11 --abi none --target "build\blender_deps" flatbuffers==25.2.10 requests==2.32.5
    if errorlevel 1 goto :failed
)
%PYTHON% -c "from gfpak_open.blender_dependencies import has_dependencies; assert has_dependencies('build/blender_deps')"
if errorlevel 1 goto :failed

echo [4/4] Creating standalone GFPAK-OPEN.exe...
%PYTHON% -m PyInstaller --noconfirm --onefile --windowed --name GFPAK-OPEN --collect-all webview --collect-all cryptography --collect-all zstandard --hidden-import ooz --add-data "build\blender_deps;blender_deps" --add-data "dist-desktop;web_dist" --add-data "gfpak_open\blender_worker.py;gfpak_open" launch.py
if errorlevel 1 goto :failed
if not exist "dist\GFPAK-OPEN.exe" goto :failed

echo.
echo ========================================================
echo  SUCCESS - PORTABLE APPLICATION CREATED
echo  %CD%\dist\GFPAK-OPEN.exe
echo ========================================================
echo  Run or copy this EXE. It is not an installer.
echo  Blender is still needed for unsupported native models.
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
