# TMS Terminal — switches the virtual display device on or off (runs as SYSTEM).
#
# Started through the scheduled task "TMS Terminal Bildschirm" (on demand, the
# server runs it) and "TMS Terminal Bildschirm Start" (at boot, with -Reset).
# Copied by display-setup.ps1 to Program Files — admin-only, so a normal user
# can't change what SYSTEM runs here. The only input is display-want.txt, and
# anything but exactly "on" means off.
param([switch]$Reset)

$StateDir = Join-Path $env:ProgramData 'TMS Terminal'
$WantFile = Join-Path $StateDir 'display-want.txt'

$want = 'off'
if ($Reset) {
  Set-Content -Path $WantFile -Value 'off' -Encoding ASCII -ErrorAction SilentlyContinue
} else {
  try {
    $w = (Get-Content -Path $WantFile -TotalCount 1 -ErrorAction Stop).Trim().ToLowerInvariant()
    if ($w -eq 'on') { $want = 'on' }
  } catch { }
}

$dev = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
  Where-Object { ($_.HardwareID -contains 'Root\MttVDD') -or ($_.FriendlyName -eq 'Virtual Display Driver') } |
  Select-Object -First 1
if (-not $dev) { exit 2 }

if ($want -eq 'on') {
  if ($dev.Status -ne 'OK') { Enable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false }
} else {
  if ($dev.Status -eq 'OK') { Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false }
}
exit 0
