@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>&1
if %ERRORLEVEL%==0 (
    set "PYTHON=py -3"
) else (
    set "PYTHON=python"
)
echo Starting GFPAK Open...
%PYTHON% -c "import webview" >nul 2>&1
if errorlevel 1 (
    echo Installing the Windows desktop viewer support...
    %PYTHON% -m pip install pywebview
    if errorlevel 1 (
        echo.
        echo Could not install pywebview. Check your Python and internet connection.
        pause
        exit /b 1
    )
)
%PYTHON% -c "import ooz; assert hasattr(ooz, 'decompress')" >nul 2>&1
if errorlevel 1 (
    echo Installing open-source Oodle support for native Pokemon models...
    %PYTHON% -m pip install --only-binary=:all: pyooz==0.0.8
    if errorlevel 1 (
        echo Warning: Oodle support could not be installed.
        echo The app will still open, but Oodle GFPAKs may require an existing DLL.
    )
)
%PYTHON% launch.py
if errorlevel 1 (
    echo.
    echo GFPAK Open could not start. Review the error above.
    pause
)
endlocal
