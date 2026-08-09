@echo off
setlocal
set "FORGE_RUNTIME=%~dp0"
set "NODE_OPTIONS=--use-system-ca %NODE_OPTIONS%"
if not exist "%FORGE_RUNTIME%data\user-data" mkdir "%FORGE_RUNTIME%data\user-data"
if not exist "%FORGE_RUNTIME%data\extensions" mkdir "%FORGE_RUNTIME%data\extensions"
call "%FORGE_RUNTIME%bin\codium.cmd" --user-data-dir "%FORGE_RUNTIME%data\user-data" --extensions-dir "%FORGE_RUNTIME%data\extensions" --disable-telemetry %*
