$ErrorActionPreference = 'Stop'
$repository = Split-Path (Split-Path (Split-Path $PSScriptRoot))
$workspace = Split-Path $repository
$project = Join-Path $workspace 'Monica-main/Monica for Android'
$build = Join-Path $workspace '.codex-tasks/20261023-extension-file-transfer/android-build'
$source = Join-Path $build 'test-sources/takagi/ru/monica/credentialexchange'
New-Item -ItemType Directory -Force -Path $source | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'app/src/androidTest/java/takagi/ru/monica/credentialexchange/TransferFixture.kt') -Destination $source
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'src/takagi/ru/monica/credentialexchange/ExtensionFileTransferInteropTest.kt') -Destination $source
$env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'
$env:MONICA_APP_INTEROP_BUILD_DIR = $build
$env:MONICA_APP_INTEROP_SOURCE_DIR = Join-Path $build 'test-sources'
$env:MONICA_APP_INTEROP_REPLACE_TEST_SOURCES = '1'
$env:MONICA_APP_INTEROP_TEST_MANIFEST = Join-Path $PSScriptRoot 'AndroidManifest.xml'
Push-Location $project
try {
    & ./gradlew.bat --init-script (Join-Path $repository 'tests/interop/android-app/interop.init.gradle') :app:assembleDebug :app:assembleDebugAndroidTest --console=plain --max-workers=2
    if ($LASTEXITCODE -ne 0) { throw 'Android instrumentation build failed' }
} finally { Pop-Location }
