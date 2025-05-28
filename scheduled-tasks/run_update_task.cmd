@echo off
REM Change directory to the location of this batch script
cd /d "%~dp0"

REM Log file
SET LOGFILE=updateBookingStatus.log

echo [%date% %time%] Running updateBookingStatus.js >> %LOGFILE%
REM Ensure node.exe is in PATH or use full path to node.exe if issues persist
node.exe updateBookingStatus.js >> %LOGFILE% 2>>&1
echo [%date% %time%] Finished updateBookingStatus.js >> %LOGFILE%
echo. >> %LOGFILE%
