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
%PYTHON% launch.py
if errorlevel 1 (
    echo.
    echo GFPAK Open could not start. Review the error above.
    pause
)
endlocal
