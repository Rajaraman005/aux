@echo off
REM Install the debug APK on a connected Android device

echo ==========================================
echo Installing APK on Android Device
echo ==========================================
echo.

set "APK_PATH=android\app\build\outputs\apk\debug\app-debug.apk"

if not exist "%APK_PATH%" (
    echo ERROR: APK not found!
    echo Run expo-run-android.bat first to build.
    exit /b 1
)

echo APK: %APK_PATH%
echo.

REM Try to find adb
set "ADB_CMD=adb"
where adb >nul 2>&1
if %ERRORLEVEL% neq 0 (
    set "ADB_CMD=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb"
)

if not exist "%ADB_CMD%" (
    echo ERROR: adb not found!
    echo Please install Android SDK Platform Tools
    echo or add adb to your PATH
    exit /b 1
)

echo Using adb: %ADB_CMD%
echo.

echo Checking for connected devices...
%ADB_CMD% devices
echo.

echo Installing APK...
%ADB_CMD% install -r "%APK_PATH%"

if %ERRORLEVEL% == 0 (
    echo.
    echo ==========================================
    echo SUCCESS! App installed.
    echo ==========================================
) else (
    echo.
    echo ==========================================
    echo FAILED! Make sure:
    echo 1. Your device is connected via USB
    echo 2. USB Debugging is enabled
    echo 3. You authorized the computer on your device
    echo ==========================================
)
