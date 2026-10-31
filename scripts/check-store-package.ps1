# Installs the Microsoft Store package on the build machine with a temporary test signature,
# starts PocketDeck from it and checks the local server answers. Proves the package and its
# manifest (startup task, firewall rules) are valid before the unsigned copy goes to the Store.
param([string]$Package, [string]$Publisher)
$ErrorActionPreference = 'Stop'

$test = Join-Path $env:RUNNER_TEMP 'PocketDeck-test.appx'
Copy-Item $Package $test

$cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature `
  -FriendlyName 'PocketDeck test' -CertStoreLocation 'Cert:\CurrentUser\My' `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$pfx = Join-Path $env:RUNNER_TEMP 'pocketdeck-test.pfx'
$pw = ConvertTo-SecureString -String 'test-only' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pw | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' -Password $pw | Out-Null

$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' | Sort-Object FullName | Select-Object -Last 1
& $signtool.FullName sign /fd SHA256 /f $pfx /p 'test-only' $test
if ($LASTEXITCODE -ne 0) { throw 'Signing the test copy failed' }

Add-AppxPackage -Path $test
$pkg = Get-AppxPackage | Where-Object { $_.Publisher -eq $Publisher } | Select-Object -First 1
if (-not $pkg) { throw 'The package did not install' }
Write-Host "Installed $($pkg.PackageFullName)"

$manifest = [xml](Get-Content (Join-Path $pkg.InstallLocation 'AppxManifest.xml'))
if (-not $manifest.Package.Applications.Application.Extensions.Extension) { throw 'Startup task missing from the manifest' }
if (-not $manifest.Package.Extensions.Extension) { throw 'Firewall rules missing from the manifest' }

Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!PocketDeck"
$ok = $false
foreach ($i in 1..30) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/hello' -TimeoutSec 3
    Write-Host "PocketDeck answered: $($r | ConvertTo-Json -Compress)"
    $ok = $true; break
  } catch { }
}
Get-Process PocketDeck -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-AppxPackage -Package $pkg.PackageFullName
Remove-Item $pfx, $test -Force
if (-not $ok) { throw 'PocketDeck from the Store package did not start its server' }
