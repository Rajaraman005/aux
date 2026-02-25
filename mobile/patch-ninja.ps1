$url = 'https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip'
$dest = 'C:\Users\Sugan001\AppData\Local\Temp\ninja-win.zip'
$extractDir = 'C:\Users\Sugan001\AppData\Local\Temp\ninja-new'
$ninjaBin = 'C:\Users\Sugan001\AppData\Local\Android\Sdk\cmake\3.22.1\bin'

Write-Host 'Downloading Ninja 1.12.1 (long-path aware)...'
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing

Write-Host 'Extracting...'
Expand-Archive -Path $dest -DestinationPath $extractDir -Force

Write-Host 'Backing up old ninja.exe...'
Copy-Item "$ninjaBin\ninja.exe" "$ninjaBin\ninja.exe.bak" -Force

Write-Host 'Replacing with new ninja.exe...'
Copy-Item "$extractDir\ninja.exe" "$ninjaBin\ninja.exe" -Force

Write-Host 'Done! New Ninja version:'
& "$ninjaBin\ninja.exe" --version

Write-Host ''
Write-Host 'Also stopping Gradle daemons...'
& 'C:\Users\Sugan001\Desktop\videocall\mobile\android\gradlew.bat' --stop

Write-Host 'All done! Now run: npx expo run:android'
