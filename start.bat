@echo off
rem ============================================================================
rem  AI Quiz Generator - one-click launcher
rem
rem  IMPORTANT: this file MUST be saved with CRLF line endings.
rem  cmd.exe tracks the read position of a batch file assuming every line
rem  ends with CRLF (2 bytes). With LF-only endings it seeks into the middle
rem  of the next line and tries to execute the remaining bytes as a command,
rem  which shows up as "'xxx' is not recognized as an internal or external
rem  command" right after start-up.
rem
rem  This file stays ASCII-only on purpose: cmd.exe decodes batch files with
rem  the active console code page, so non-ASCII text would be garbled on
rem  machines using code page 936/437. Every user facing message (Chinese)
rem  comes from scripts\start.ps1, which PowerShell renders correctly.
rem ============================================================================
setlocal

set "APP_DIR=%~dp0"
set "PS_SCRIPT=%APP_DIR%scripts\start.ps1"
set "PS_EXE="
set "RC=0"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] scripts\start.ps1 was not found next to start.bat.
    echo         Keep start.bat in the project root so it can find the
    echo         scripts folder, then run it again.
    set "RC=1"
    goto :finish
)

rem --- locate a PowerShell host -------------------------------------------
where powershell.exe >nul 2>&1
if not errorlevel 1 set "PS_EXE=powershell.exe"
if defined PS_EXE goto :launch

where pwsh.exe >nul 2>&1
if not errorlevel 1 set "PS_EXE=pwsh.exe"
if defined PS_EXE goto :launch

if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
    set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
    goto :launch
)

echo [ERROR] No PowerShell host was found on this machine.
echo         Install PowerShell 7 (pwsh) or enable Windows PowerShell 5.1,
echo         then run start.bat again.
set "RC=1"
goto :finish

rem --- run the launcher ----------------------------------------------------
:launch
echo Using PowerShell host: %PS_EXE%
echo.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :failed

echo.
echo [OK] Service stopped.
goto :finish

:failed
echo.
echo [ERROR] scripts\start.ps1 exited with code %RC%.
echo         Read the messages above, fix the cause, then run start.bat again.

:finish
echo.
echo Press any key to close this window...
pause >nul
endlocal & exit /b %RC%
