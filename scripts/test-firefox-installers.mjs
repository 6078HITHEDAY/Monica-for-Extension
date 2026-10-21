// Exercise installer manifests and lifecycle with registry operations mocked.
// No production registration is created, changed or removed by this test.
import { mkdtemp,mkdir,copyFile,writeFile,readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),scratch=path.join(root,'.tmp');await mkdir(scratch,{recursive:true});
const run=await mkdtemp(path.join(scratch,'firefox-installers-')),bundle=path.join(run,'bundle');await mkdir(bundle);
for(const file of ['install-host.ps1','uninstall-host.ps1','install-wifi.ps1'])await copyFile(path.join(root,'native/mdbx2-host',file),path.join(bundle,file));
const binary=Buffer.from('synthetic installer fixture (not executable)');await writeFile(path.join(bundle,'monica-mdbx2-host.exe'),binary);
await writeFile(path.join(bundle,'WIFI-HELPER.json'),JSON.stringify({sha256:createHash('sha256').update(binary).digest('hex')}));
const script=path.join(run,'verify.ps1');
await writeFile(script,`param([string]$TestRoot)
$ErrorActionPreference='Stop'
$global:firefoxInstallerTestEvents=[System.Collections.Generic.List[object]]::new()
function New-Item {param([string]$Path,[string]$ItemType,[switch]$Force) if($Path.StartsWith('HKCU:')){$global:firefoxInstallerTestEvents.Add(@{op='create';key=$Path});return};Microsoft.PowerShell.Management\\New-Item -Path $Path -ItemType $ItemType -Force:$Force}
function Set-Item {param([string]$Path,[string]$LiteralPath,$Value) $p=if($LiteralPath){$LiteralPath}else{$Path};if(-not $p.StartsWith('HKCU:')){throw 'Unexpected mutation'};$global:firefoxInstallerTestEvents.Add(@{op='set';key=$p;value=$Value})}
function Test-Path {param([string]$Path,[string]$LiteralPath,[string]$PathType) $p=if($LiteralPath){$LiteralPath}else{$Path};if($p.StartsWith('HKCU:')){return $false};if($PathType){return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $p -PathType $PathType};return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $p}
function Remove-Item {param([string]$LiteralPath,[switch]$Recurse,[switch]$Force) if($LiteralPath.StartsWith('HKCU:')){$global:firefoxInstallerTestEvents.Add(@{op='remove';key=$LiteralPath});return};$resolved=[IO.Path]::GetFullPath($LiteralPath);if(-not $resolved.StartsWith($TestRoot+[IO.Path]::DirectorySeparatorChar)){throw 'Unsafe test deletion'};Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $resolved -Recurse:$Recurse -Force:$Force}
$bundle=Join-Path $TestRoot 'bundle'
foreach($name in @('install-host.ps1','uninstall-host.ps1','install-wifi.ps1')){$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $bundle $name),[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}}
$hostRoot=Join-Path $TestRoot 'host-install'
& (Join-Path $bundle 'install-host.ps1') -FirefoxExtensionId 'monica@monica-pass.github.io' -EdgeExtensionId 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -InstallRoot $hostRoot
$firefox=Get-Content (Join-Path $hostRoot 'com.monica_pass.mdbx2.firefox.json') -Raw|ConvertFrom-Json
$hello=Get-Content (Join-Path $hostRoot 'com.monica_pass.windows_hello.firefox.json') -Raw|ConvertFrom-Json
$edge=Get-Content (Join-Path $hostRoot 'com.monica_pass.mdbx2.json') -Raw|ConvertFrom-Json
if(@($firefox.allowed_extensions).Count-ne 1 -or $firefox.allowed_extensions[0]-cne 'monica@monica-pass.github.io' -or $firefox.PSObject.Properties.Name-contains 'allowed_origins' -or $hello.allowed_extensions[0]-cne 'monica@monica-pass.github.io'){throw 'Firefox allowlist failure'}
if($edge.allowed_origins[0]-ne 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'){throw 'Chromium regression'}
$wifiRoot=Join-Path $TestRoot 'wifi-install'
& (Join-Path $bundle 'install-wifi.ps1') -FirefoxExtensionId 'monica@monica-pass.github.io' -InstallRoot $wifiRoot
$wifi=Get-Content (Join-Path $wifiRoot 'firefox-com.monica_pass.mdbx2.json') -Raw|ConvertFrom-Json
if($wifi.allowed_extensions[0]-cne 'monica@monica-pass.github.io'){throw 'WiFi allowlist failure'}
foreach($file in @('install-host.ps1','install-wifi.ps1')){$denied=$false;try{& (Join-Path $bundle $file) -FirefoxExtensionId 'attacker@local.test' -InstallRoot (Join-Path $TestRoot 'must-not-exist')}catch{$denied=$true};if(-not $denied){throw 'Other add-on accepted'}}
& (Join-Path $bundle 'uninstall-host.ps1') -InstallRoot $hostRoot
@{events=@($global:firefoxInstallerTestEvents);firefox=$firefox;hello=$hello;edge=$edge;wifi=$wifi;invalidIdDenied=$true;uninstalled=(-not (Test-Path -LiteralPath $hostRoot))}|ConvertTo-Json -Depth 8|Set-Content (Join-Path $TestRoot 'evidence.json')
`);
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-TestRoot',run],{windowsHide:true,stdio:'inherit',env:{...process.env,PSModulePath:undefined}});
const evidence=JSON.parse(await readFile(path.join(run,'evidence.json'),'utf8'));assert.equal(evidence.invalidIdDenied,true);assert.equal(evidence.uninstalled,true);
assert.equal(evidence.events.filter(e=>e.op==='set'&&e.key.includes('Mozilla')).length,3);
console.log('Firefox installers passed: exact add-on ID, independent manifests, mixed Edge registration, Wi-Fi, invalid-ID refusal and uninstall; registry mocked.');
