# TMS Terminal — virtual display, one-time setup (runs ELEVATED, once).
#
# Why: with the remote "Bildschirm aus" switch, Windows should draw onto an
# invisible monitor while the laptop panel is really off (like Win+P "second
# screen only"). The invisible monitor comes from the open-source, signed
# Virtual Display Driver (github.com/VirtualDrivers/Virtual-Display-Driver,
# MIT). Installing a driver needs admin rights — this script is the only part
# that does; everything at session time runs as the normal user.
#
# What it sets up:
#   - the driver (installed with nefcon, MIT, like the project's own
#     silent-install script), downloads pinned to a version AND a SHA-256,
#   - the device DISABLED: no extra monitor while nobody uses remote access,
#   - C:\VirtualDisplayDriver\vdd_settings.xml: one monitor, exactly the sizes
#     the app streams (1280x800 / 1600x1000 / 1920x1200 ...), so nothing scales,
#   - task "TMS Terminal Bildschirm" (SYSTEM, run on demand, runnable by
#     signed-in users): switches the device on/off as display-want.txt says —
#     the user can only pick on/off, the script itself is admin-only,
#   - task "TMS Terminal Bildschirm Start" (SYSTEM, at boot): forces it off, so
#     a crash with the panel off never survives a restart.
#
# -Install / -Uninstall; progress goes to -Log (the non-elevated CLI shows it).
param([switch]$Install, [switch]$Uninstall, [string]$Log)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$DriverUrl  = 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip'
$DriverSha  = 'E24210692B442B39AF763536330CE78B423F19342B7A7792C26DE3944E418B3A'
$NefconUrl  = 'https://github.com/nefarius/nefcon/releases/download/v1.21.0/nefcon_v1.21.0.zip'
$NefconSha  = '4C8E68F6B663598D77B7C3F76459B16FAD00994E53EA8AF0BD106A805DD5C18B'
$HardwareId = 'Root\MttVDD'
$TaskName   = 'TMS Terminal Bildschirm'
$BootTask   = 'TMS Terminal Bildschirm Start'
$ProgramDir = Join-Path $env:ProgramFiles 'TMS Terminal'
$StateDir   = Join-Path $env:ProgramData 'TMS Terminal'
$WantFile   = Join-Path $StateDir 'display-want.txt'
$ConfDir    = 'C:\VirtualDisplayDriver'
$Marker     = Join-Path $ProgramDir 'display-installed.txt'
$Version    = '25.7.23'

function Say([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  if ($Log) { try { Add-Content -Path $Log -Value $line -Encoding UTF8 } catch { } }
  Write-Host $m
}

function Get-Vdd {
  Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
    Where-Object { ($_.HardwareID -contains $HardwareId) -or ($_.FriendlyName -eq 'Virtual Display Driver') } |
    Select-Object -First 1
}

function Get-Verified([string]$url, [string]$sha, [string]$file) {
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  $got = (Get-FileHash -Path $file -Algorithm SHA256).Hash
  if ($got -ne $sha) { throw "Pruefsumme falsch fuer $url (erwartet $sha, bekommen $got) - Abbruch, nichts installiert." }
}

$SettingsXml = @'
<?xml version='1.0' encoding='utf-8'?>
<vdd_settings>
    <monitors>
        <count>1</count>
    </monitors>
    <gpu>
        <friendlyname>default</friendlyname>
    </gpu>
    <global>
        <g_refresh_rate>60</g_refresh_rate>
    </global>
    <resolutions>
        <resolution><width>1920</width><height>1200</height><refresh_rate>60</refresh_rate></resolution>
        <resolution><width>1600</width><height>1000</height><refresh_rate>60</refresh_rate></resolution>
        <resolution><width>1280</width><height>800</height><refresh_rate>60</refresh_rate></resolution>
        <resolution><width>1920</width><height>1080</height><refresh_rate>60</refresh_rate></resolution>
        <resolution><width>1600</width><height>900</height><refresh_rate>60</refresh_rate></resolution>
        <resolution><width>1280</width><height>720</height><refresh_rate>60</refresh_rate></resolution>
        <resolution><width>2560</width><height>1600</height><refresh_rate>60</refresh_rate></resolution>
    </resolutions>
    <options>
        <CustomEdid>false</CustomEdid>
        <PreventSpoof>false</PreventSpoof>
        <EdidCeaOverride>false</EdidCeaOverride>
        <HardwareCursor>true</HardwareCursor>
        <SDR10bit>false</SDR10bit>
        <HDRPlus>false</HDRPlus>
        <logging>false</logging>
        <debuglogging>false</debuglogging>
    </options>
</vdd_settings>
'@

function Register-Tasks([string]$taskScript) {
  $run = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $taskScript
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances Queue
  # On demand: the server writes on/off into display-want.txt and runs this.
  Register-ScheduledTask -TaskName $TaskName -Force -Principal $principal -Settings $settings `
    -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $run) | Out-Null
  # At boot: always off.
  Register-ScheduledTask -TaskName $BootTask -Force -Principal $principal -Settings $settings `
    -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ($run + ' -Reset')) | Out-Null
  # Signed-in users may RUN the on-demand task (read + execute), nothing else.
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $task = $svc.GetFolder('\').GetTask($TaskName)
  $sd = $task.GetSecurityDescriptor(4)
  if ($sd -notmatch '\(A;;GRGX;;;AU\)') { $task.SetSecurityDescriptor($sd + '(A;;GRGX;;;AU)', 0) }
}

function Do-Install {
  Say 'Virtueller Bildschirm wird eingerichtet...'
  $tmp = Join-Path $env:TEMP ('tms-vdd-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Say 'Lade Treiber und Installationswerkzeug (feste Version, Pruefsumme)...'
    Get-Verified $DriverUrl $DriverSha (Join-Path $tmp 'driver.zip')
    Get-Verified $NefconUrl $NefconSha (Join-Path $tmp 'nefcon.zip')
    Expand-Archive -Path (Join-Path $tmp 'driver.zip') -DestinationPath (Join-Path $tmp 'driver') -Force
    Expand-Archive -Path (Join-Path $tmp 'nefcon.zip') -DestinationPath (Join-Path $tmp 'nefcon') -Force
    $inf = Join-Path $tmp 'driver\VirtualDisplayDriver\MttVDD.inf'
    $cat = Join-Path $tmp 'driver\VirtualDisplayDriver\mttvdd.cat'
    $nefcon = Join-Path $tmp 'nefcon\x64\nefconc.exe'

    New-Item -ItemType Directory -Path $ProgramDir -Force | Out-Null
    Copy-Item $nefcon (Join-Path $ProgramDir 'nefconc.exe') -Force
    Copy-Item (Join-Path $PSScriptRoot 'display-task.ps1') (Join-Path $ProgramDir 'display-task.ps1') -Force

    Say 'Einstellungen (Aufloesungen passend zur App)...'
    New-Item -ItemType Directory -Path $ConfDir -Force | Out-Null
    Set-Content -Path (Join-Path $ConfDir 'vdd_settings.xml') -Value $SettingsXml -Encoding UTF8

    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    Set-Content -Path $WantFile -Value 'off' -Encoding ASCII
    & icacls.exe $WantFile /grant '*S-1-5-32-545:(M)' | Out-Null   # Users: may write on/off

    # The driver is signed by "SignPath Foundation": trusting that publisher
    # lets Windows install it without a second dialog.
    $certs = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
    $certs.Import([IO.File]::ReadAllBytes($cat))
    $leaf = $certs | Where-Object { $_.Subject -like '*SignPath Foundation*' } | Select-Object -First 1
    if ($leaf) {
      $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('TrustedPublisher', 'LocalMachine')
      $store.Open('ReadWrite'); $store.Add($leaf); $store.Close()
    }

    if (-not (Get-Vdd)) {
      Say 'Installiere den Treiber...'
      & $nefcon install $inf $HardwareId | ForEach-Object { Say ('  ' + $_) }
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "Treiber-Installation fehlgeschlagen (nefcon $LASTEXITCODE)" }
    } else {
      Say 'Treiber ist schon da.'
    }
    $dev = $null
    for ($i = 0; $i -lt 40 -and -not $dev; $i++) { Start-Sleep -Milliseconds 500; $dev = Get-Vdd }
    if (-not $dev) { throw 'Der virtuelle Bildschirm ist nach der Installation nicht aufgetaucht.' }
    if ($dev.Status -eq 'OK') { Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false }
    Say 'Treiber installiert (ausgeschaltet, bis du den Fernzugriff nutzt).'

    Say 'Richte die Schalt-Aufgabe ein...'
    Register-Tasks (Join-Path $ProgramDir 'display-task.ps1')
    Set-Content -Path $Marker -Value $Version -Encoding ASCII
    Say 'ERGEBNIS: OK'
  } finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Do-Uninstall {
  Say 'Virtueller Bildschirm wird entfernt...'
  foreach ($t in @($TaskName, $BootTask)) { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
  $nefcon = Join-Path $ProgramDir 'nefconc.exe'
  if (Test-Path $nefcon) { & $nefcon remove $HardwareId | ForEach-Object { Say ('  ' + $_) } }
  foreach ($f in @($Marker, (Join-Path $ProgramDir 'display-task.ps1'), $nefcon, $WantFile, (Join-Path $StateDir 'display-state.txt'))) {
    Remove-Item -Path $f -Force -ErrorAction SilentlyContinue
  }
  Say 'ERGEBNIS: OK'
}

try {
  if ($Install) { Do-Install }
  elseif ($Uninstall) { Do-Uninstall }
  else { Say 'Aufruf: -Install oder -Uninstall'; exit 2 }
  exit 0
} catch {
  Say ('ERGEBNIS: FEHLER ' + $_.Exception.Message)
  exit 1
}
