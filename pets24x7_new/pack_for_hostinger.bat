@echo off
REM Pets24x7 — bundle everything Hostinger needs into ONE zip.
REM Excludes Python build scripts, README/markdown, .bat helpers, the Apps Script template.
REM Output: pets24x7-deploy.zip (next to this script)

setlocal
cd /d "%~dp0"

set ZIP=pets24x7-deploy.zip
if exist "%ZIP%" del "%ZIP%"

echo Packing Pets24x7 for Hostinger upload...
echo Excluding: *.py *.md *.bat *.toml *.gs *.json (vercel.json), data prep files
echo.

powershell -NoProfile -Command ^
  "$exclude = @('*.py','*.md','*.bat','*.toml','*.zip','LEADS-APPS-SCRIPT.gs','vercel.json','_redirects','_headers','netlify.toml','pack_for_hostinger.bat','start_local.bat','build_data.py','build_pages.py'); ^
   Get-ChildItem -Path . -Force -Recurse -File ^
     | Where-Object { $name = $_.Name; -not ($exclude | Where-Object { $name -like $_ }) } ^
     | Compress-Archive -DestinationPath '%ZIP%' -CompressionLevel Optimal -Force"

if exist "%ZIP%" (
  echo.
  echo ========================================================
  echo  Done. Upload %ZIP% to Hostinger File Manager
  echo  Drop it in public_html/ then right-click -^> Extract.
  echo ========================================================
  echo.
  dir "%ZIP%" | findstr "%ZIP%"
) else (
  echo ERROR: zip not produced. Check PowerShell errors above.
)

pause
