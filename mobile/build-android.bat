@echo off
REM Build script for Android that disables problematic Gradle features
REM Run this instead of 'npx expo run:android' for better stability

set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
REM Disable configuration cache which is incompatible with React Native/Expo
set "GRADLE_OPTS=--no-configuration-cache"

echo ==========================================
echo Building with optimized settings
echo JAVA_HOME=%JAVA_HOME%
echo GRADLE_OPTS=%GRADLE_OPTS%
echo ==========================================
echo.

cd android
call gradlew.bat clean
call gradlew.bat app:assembleDebug -x lint -x test -PreactNativeDevServerPort=8081 --build-cache

echo.
echo Build complete! Check android\app\build\outputs\apk\debug\ for the APK
