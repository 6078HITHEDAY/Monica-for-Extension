#requires -Version 7.4
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repository = Split-Path (Split-Path (Split-Path $PSScriptRoot))
$workspace = Split-Path $repository
$adb = 'D:/AndroidSDK/platform-tools/adb.exe'
$build = Join-Path $workspace '.codex-tasks/20261023-extension-file-transfer/android-build/app/outputs/apk'
# Select only the shared public AVD. Never create another AVD or clear app data.
$devices = & $adb devices
$serial = $null
foreach ($line in $devices) {
    if ($line -match '^(emulator-\d+)\s+device\s*$') {
        $candidate = $Matches[1]
        $name = & $adb -s $candidate emu avd name
        if ($name -match '^Monica_Issue136_API_32\s*$') { $serial = $candidate; break }
    }
}
if (-not $serial) { throw 'Start the shared Monica_Issue136_API_32 AVD before running this suite.' }
$users = & $adb -s $serial shell pm list users
if (-not ($users -match 'UserInfo\{10:Monica:')) { throw 'Expected the existing Monica test user 10; no user has been created or modified.' }
& $adb -s $serial shell am start-user -w 10
if ($LASTEXITCODE) { throw 'Could not start the existing Monica test user' }
$userState = & $adb -s $serial shell am get-started-user-state 10
if (-not ($userState -match '^RUNNING_UNLOCKED\s*$')) { throw 'Unlock the existing Monica test user before running this suite.' }
Push-Location $repository
try {
    if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'build.ps1') }
    $app = Get-ChildItem -LiteralPath (Join-Path $build 'debug') -Filter '*arm64-v8a*.APK' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $app) { throw 'Build the current Android application first.' }
    & $adb -s $serial install -r --user 10 $app.FullName
    if ($LASTEXITCODE) { throw 'Application installation failed' }
    & $adb -s $serial install -r --user 10 (Join-Path $build 'androidTest/debug/app-debug-androidTest.apk')
    if ($LASTEXITCODE) { throw 'Instrumentation installation failed' }
    & npx esbuild tests/interop/file-transfer-fixtures.ts --bundle --platform=node --format=cjs --packages=external --outfile=.tmp/file-transfer-fixtures.cjs
    if ($LASTEXITCODE) { throw 'Fixture compilation failed' }
    & node .tmp/file-transfer-fixtures.cjs
    if ($LASTEXITCODE) { throw 'Fixture generation failed' }
    $remote = '/data/local/tmp/extension-file-transfer-20261023'
    & $adb -s $serial push .tmp/file-transfer-interop/. "$remote/"
    if ($LASTEXITCODE) { throw 'Fixture push failed' }
    & $adb -s $serial shell run-as takagi.ru.monica --user 10 mkdir -p files/extension-file-transfer-20261023
    & $adb -s $serial shell run-as takagi.ru.monica --user 10 cp -r "$remote/." files/extension-file-transfer-20261023/
    if ($LASTEXITCODE) { throw 'Fixture staging failed' }
    $result = & $adb -s $serial shell am instrument --user 10 -w -r -e class takagi.ru.monica.credentialexchange.ExtensionFileTransferInteropTest takagi.ru.monica.test/androidx.test.runner.AndroidJUnitRunner
    $result | Set-Content -LiteralPath .tmp/file-transfer-interop/android-instrumentation.txt -Encoding utf8
    if (-not ($result -match '^OK \(1 test\)')) { throw 'Android interop failed; inspect android-instrumentation.txt' }
    foreach ($name in @('android-return.zip', 'android-return.kdbx', 'android-kdbx-return.kdbx', 'android-result.json')) {
        # PowerShell 7.4+ preserves native binary stdout during redirection.
        & $adb -s $serial exec-out run-as takagi.ru.monica --user 10 cat "files/extension-file-transfer-20261023/$name" > (Join-Path '.tmp/file-transfer-interop' $name)
        if ($LASTEXITCODE) { throw "Failed to retrieve $name" }
    }
    & node .tmp/file-transfer-fixtures.cjs --verify
    if ($LASTEXITCODE) { throw 'Extension readback failed' }
    Write-Output 'Android file migration and strict extension readback passed.'
} finally { Pop-Location }
