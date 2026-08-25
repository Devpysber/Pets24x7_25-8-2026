@echo off
REM Pets24x7 — local preview server.
REM Double-click this file. It will:
REM   1. Serve the site from this folder on http://localhost:8000
REM   2. Auto-open your browser to it
REM   3. Keep running until you close this window (or hit Ctrl+C)
REM
REM You MUST use this (or another HTTP server) to test the site.
REM Double-clicking index.html in your file explorer will NOT work
REM because clean URLs like /in/mumbai/ only resolve over HTTP.

setlocal
cd /d "%~dp0"

REM Try the user-installed Python first, then fall back to PATH.
set "PY=%LOCALAPPDATA%\Python\bin\python3.exe"
if not exist "%PY%" set "PY=python"

echo.
echo ========================================================
echo  Pets24x7 local preview server
echo  Serving:  %CD%
echo  URL:      http://localhost:8000/
echo  Stop:     Close this window or press Ctrl+C
echo ========================================================
echo.

start "" http://localhost:8000/
"%PY%" -m http.server 8000
