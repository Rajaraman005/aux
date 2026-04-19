@echo off
REM Clean build script for Android
REM This wipes all caches and rebuilds from scratch

echo ==========================================
echo CLEAN BUILD - Android
echo ==========================================
echo.

set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
set "GRADLE_OPTS=--no-configuration-cache"

echo JAVA_HOME=%JAVA_HOME%
echo GRADLE_OPTS=%GRADLE_OPTS%
echo.

cd android

echo Cleaning Gradle caches...
call gradlew.bat clean 2>nul

echo.
echo Building APK...
call gradlew.bat app:assembleDebug -x lint -x test -PreactNativeDevServerPort=8081 --build-cache

echo.
echo ==========================================
if %ERRORLEVEL% == 0 (
    echo BUILD SUCCESS!
    echo APK location: app\build\outputs\apk\debug\app-debug.apk
) else (
    echo BUILD FAILED!
)
echo ==========================================
