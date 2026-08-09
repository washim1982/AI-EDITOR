@echo off
setlocal
set "FORGE_RUNTIME=%~dp0"
set "FORGE_USER_ROOT=%LOCALAPPDATA%\Forge Local Agent IDE"
set "NODE_OPTIONS=--use-system-ca %NODE_OPTIONS%"
if not exist "%FORGE_USER_ROOT%\user-data" mkdir "%FORGE_USER_ROOT%\user-data"
if not exist "%FORGE_USER_ROOT%\extensions" mkdir "%FORGE_USER_ROOT%\extensions"
call "%FORGE_RUNTIME%bin\codium.cmd" --user-data-dir "%FORGE_USER_ROOT%\user-data" --extensions-dir "%FORGE_USER_ROOT%\extensions" --disable-telemetry %*
