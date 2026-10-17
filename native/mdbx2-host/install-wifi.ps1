[CmdletBinding()]
param(
    [string]$ChromeExtensionId = '',
    [string]$EdgeExtensionId = '',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Monica\Extension\WiFi')
)
$ErrorActionPreference = 'Stop'
foreach ($WifiId in @($ChromeExtensionId, $EdgeExtensionId)) {
    if ($WifiId -and $WifiId -notmatch '^[a-p]{32}$') { throw 'Invalid extension ID.' }
}
if (-not $ChromeExtensionId -and -not $EdgeExtensionId) { throw 'Provide a Chrome or Edge extension ID.' }
$WifiSource = Join-Path $PSScriptRoot 'monica-mdbx2-host.exe'
$WifiMetadata = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'WIFI-HELPER.json') -Raw | ConvertFrom-Json
if ($WifiMetadata.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $WifiSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $WifiMetadata.sha256) { throw 'Component checksum mismatch.' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$WifiExecutable = Join-Path $InstallRoot 'monica-mdbx2-host.exe'
Copy-Item -LiteralPath $WifiSource -Destination $WifiExecutable -Force
$WifiUtf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($WifiBrowser in @(@('Google\Chrome', $ChromeExtensionId, 'chrome'), @('Microsoft\Edge', $EdgeExtensionId, 'edge'))) {
    if (-not $WifiBrowser[1]) { continue }
    $WifiKey = 'HKCU:\Software\' + $WifiBrowser[0] + '\NativeMessagingHosts\com.monica_pass.mdbx2'
    $WifiOrigins = @('chrome-extension://' + $WifiBrowser[1] + '/')
    if (Test-Path -LiteralPath $WifiKey) {
        $WifiOldPath = (Get-Item -LiteralPath $WifiKey).GetValue('')
        if ($WifiOldPath -and (Test-Path -LiteralPath $WifiOldPath -PathType Leaf)) {
            $WifiOld = Get-Content -LiteralPath $WifiOldPath -Raw | ConvertFrom-Json
            if ($WifiOld.name -ne 'com.monica_pass.mdbx2') { throw 'Unexpected existing component registration.' }
            foreach ($WifiOrigin in $WifiOld.allowed_origins) {
                if ($WifiOrigin -notmatch '^chrome-extension://[a-p]{32}/$') { throw 'Unexpected existing extension origin.' }
                $WifiOrigins += $WifiOrigin
            }
        }
    }
    $WifiManifest = Join-Path $InstallRoot ($WifiBrowser[2] + '-com.monica_pass.mdbx2.json')
    $WifiJson = @{ name='com.monica_pass.mdbx2'; description='Monica Wi-Fi communication'; path=$WifiExecutable; type='stdio'; allowed_origins=@($WifiOrigins | Sort-Object -Unique) } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($WifiManifest, $WifiJson, $WifiUtf8)
    New-Item -Path $WifiKey -Force | Out-Null
    Set-Item -LiteralPath $WifiKey -Value $WifiManifest
}
Write-Output 'Monica Wi-Fi component configured. Return to the extension and retry pairing. No administrator access is required.'
