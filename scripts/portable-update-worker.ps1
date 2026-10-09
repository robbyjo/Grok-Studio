param([Parameter(Mandatory=$true)][string]$Journal, [switch]$NoLaunch, [int]$LauncherPid = 0)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
function Write-Journal($value) {
  $taskTemp = Join-Path $taskRoot ('journal-' + [guid]::NewGuid().ToString() + '.json')
  [IO.File]::WriteAllText($taskTemp, ($value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $taskTemp -Destination $Journal -Force
}
function Hash-File([string]$path) {
  $taskStream = [IO.File]::OpenRead($path)
  $taskHash = [Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($taskHash.ComputeHash($taskStream))).Replace('-', '').ToLowerInvariant() }
  finally { $taskHash.Dispose(); $taskStream.Dispose() }
}
function Check-Owned([string]$path) {
  $taskFull = [IO.Path]::GetFullPath($path)
  if ([IO.Path]::GetDirectoryName($taskFull) -ne $taskRoot) { throw 'Update file is outside its journal folder.' }
  if (Test-Path -LiteralPath $taskFull) {
    $taskInfo = Get-Item -LiteralPath $taskFull -Force
    if ($taskInfo.PSIsContainer -or ($taskInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Update file is linked or not a file.' }
  }
  return $taskFull
}
$Journal = [IO.Path]::GetFullPath($Journal)
$taskRoot = [IO.Path]::GetDirectoryName($Journal)
if ((Get-Item -LiteralPath $taskRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked update folder.' }
if ((Get-Item -LiteralPath $Journal -Force).Length -gt 65536) { throw 'Oversized update journal.' }
$taskJob = Get-Content -LiteralPath $Journal -Raw | ConvertFrom-Json
if ($taskJob.format -ne 1 -or $taskJob.state -notin @('prepared', 'rollbackPrepared')) { throw 'Update is not prepared.' }
$taskJob | Add-Member -NotePropertyName workerPid -NotePropertyValue $PID -Force
$taskJob | Add-Member -NotePropertyName launcherPid -NotePropertyValue $LauncherPid -Force
Write-Journal $taskJob
try {
$taskExe = [IO.Path]::GetFullPath($taskJob.executable)
$taskExeFolder = [IO.Path]::GetDirectoryName($taskExe)
if ((Get-Item -LiteralPath $taskExeFolder -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked executable folder.' }
if ([IO.Path]::GetExtension($taskExe) -ne '.exe') { throw 'Invalid portable executable.' }
$taskSelected = Check-Owned $(if ($taskJob.operation -eq 'apply') { $taskJob.staged } else { $taskJob.rollback })
$taskRollback = Check-Owned $taskJob.rollback
$taskDisplaced = Check-Owned $taskJob.displaced
$taskExpected = if ($taskJob.operation -eq 'apply') { $taskJob.sha256 } else { $taskJob.previousSha256 }
if ((Hash-File $taskSelected) -ne $taskExpected) { throw 'Update checksum changed.' }
if ($taskJob.operation -eq 'apply') {
  if ($taskJob.migration) {
    if ($taskJob.migration -ne 'same-native-format-v1' -or -not $taskJob.profileBackup) { throw 'Migration has no verified profile backup.' }
    $taskBackupRoot = [IO.Path]::GetFullPath((Join-Path $taskRoot 'profile-backups'))
    $taskBackup = [IO.Path]::GetFullPath($taskJob.profileBackup.folder)
    if ([IO.Path]::GetDirectoryName($taskBackup) -ne $taskBackupRoot -or (Get-Item -LiteralPath $taskBackup -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid profile backup folder.' }
    $taskManifestPath = Join-Path $taskBackup 'manifest.json'
    if ((Get-Item -LiteralPath $taskManifestPath -Force).Length -gt 8MB -or (Hash-File $taskManifestPath) -ne $taskJob.profileBackup.manifestHash) { throw 'Profile backup manifest changed.' }
    $taskManifest = Get-Content -LiteralPath $taskManifestPath -Raw | ConvertFrom-Json
    if ($taskManifest.format -ne 1 -or $taskManifest.files.Count -gt 20000) { throw 'Invalid profile backup manifest.' }
    foreach ($taskEntry in $taskManifest.files) {
      if ([IO.Path]::IsPathRooted($taskEntry.path) -or $taskEntry.path -match '(^|[\\/])\.\.([\\/]|$)|:') { throw 'Unsafe backup file path.' }
      $taskBackupFile = [IO.Path]::GetFullPath((Join-Path (Join-Path $taskBackup 'profile') $taskEntry.path))
      if (-not $taskBackupFile.StartsWith((Join-Path $taskBackup 'profile') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Escaping backup file.' }
      $taskParent = $taskBackupFile
      while ($taskParent.Length -gt $taskBackup.Length) {
        if ((Get-Item -LiteralPath $taskParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked backup file.' }
        $taskParent = [IO.Path]::GetDirectoryName($taskParent)
      }
      if ((Get-Item -LiteralPath $taskBackupFile -Force).Length -ne $taskEntry.bytes -or (Hash-File $taskBackupFile) -ne $taskEntry.sha256) { throw 'Profile backup file changed.' }
    }
  }
  $taskSignature = Get-AuthenticodeSignature -LiteralPath $taskSelected
  if ($taskJob.signerThumbprint) {
    if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Thumbprint -ne $taskJob.signerThumbprint) { throw 'Update signature verification failed.' }
  } elseif (-not $taskJob.allowUnsigned) { throw 'Unsigned update was not approved.' }
}
$taskJob | Add-Member -NotePropertyName workerReady -NotePropertyValue $true -Force
Write-Journal $taskJob
if ($taskJob.ownerPid -gt 0) { Wait-Process -Id $taskJob.ownerPid -Timeout 60 -ErrorAction SilentlyContinue; if (Get-Process -Id $taskJob.ownerPid -ErrorAction SilentlyContinue) { throw 'Workbench has not exited. Original retained.' } }
# The self-extracting portable launcher may outlive the Electron child briefly.
$taskDeadline = [DateTime]::UtcNow.AddSeconds(15)
while ((Get-Process | Where-Object { $_.Path -and $_.Path -ieq $taskExe }) -and [DateTime]::UtcNow -lt $taskDeadline) { Start-Sleep -Milliseconds 250 }
if (Get-Process | Where-Object { $_.Path -and $_.Path -ieq $taskExe }) { throw 'Portable launcher is still running. Original retained.' }
if ((Get-Item -LiteralPath $taskExe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked executable.' }
if ((Hash-File $taskExe) -ne $(if ($taskJob.operation -eq 'apply') { $taskJob.previousSha256 } else { $taskJob.sha256 })) { throw 'Installed executable changed; original retained.' }
if (Test-Path -LiteralPath $taskDisplaced) { throw 'Recovery file already exists.' }
if ($taskJob.operation -eq 'apply' -and (Test-Path -LiteralPath $taskRollback)) { throw 'Rollback already exists.' }
  if ($taskJob.operation -eq 'apply') {
    [IO.File]::Replace($taskSelected, $taskExe, $taskRollback, $true)
    $taskJob.state = 'installed'
  } else {
    $taskRestore = Check-Owned (Join-Path $taskRoot ('restore-' + [guid]::NewGuid().ToString() + '.exe'))
    Copy-Item -LiteralPath $taskSelected -Destination $taskRestore
    if ((Hash-File $taskRestore) -ne $taskExpected) { throw 'Rollback copy failed verification.' }
    [IO.File]::Replace($taskRestore, $taskExe, $taskDisplaced, $true)
    $taskJob.state = 'rolledBack'
  }
  Write-Journal $taskJob
  if (-not $NoLaunch) { Start-Process -FilePath $taskExe -WindowStyle Hidden }
} catch {
  $taskJob.state = 'repairRequired'; $taskJob | Add-Member -NotePropertyName error -NotePropertyValue $_.Exception.Message -Force; Write-Journal $taskJob; throw
}
