param([Parameter(Mandatory = $true)][string]$GrokHome)
$ErrorActionPreference = 'Stop'
# Optional provider installation. Never reads or writes account credentials.
$providerVersion = '2.0.1'
$providerZipHash = 'ec37110134fd94f2980ae78ed0d69493623e730da97f0983050cc46539c30a30'
$providerExeHash = 'e4cdefe436b7d7073fb8a542389f3e08764787003e5f240861e1a91937a2bb65'
$providerTarget = Join-Path ([IO.Path]::GetFullPath($GrokHome)) 'tools\github'
$providerTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$providerTemp = Join-Path $providerTempRoot ('grok-studio-github-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $providerTemp | Out-Null
try {
  $providerZip = Join-Path $providerTemp 'provider.zip'
  Invoke-WebRequest "https://github.com/github/github-mcp-server/releases/download/v$providerVersion/github-mcp-server_Windows_x86_64.zip" -OutFile $providerZip
  if ((Get-FileHash -LiteralPath $providerZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $providerZipHash) { throw 'GitHub release archive checksum mismatch.' }
  Expand-Archive -LiteralPath $providerZip -DestinationPath (Join-Path $providerTemp 'expanded')
  $providerExe = Join-Path $providerTemp 'expanded\github-mcp-server.exe'
  if ((Get-FileHash -LiteralPath $providerExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $providerExeHash) { throw 'GitHub executable checksum mismatch.' }
  New-Item -ItemType Directory -Path $providerTarget -Force | Out-Null
  Copy-Item -LiteralPath $providerExe -Destination $providerTarget
  Get-ChildItem -LiteralPath (Join-Path $providerTemp 'expanded') -File | Where-Object { $_.Name -match '^(LICENSE|NOTICE)' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $providerTarget }
  Write-Output "Installed official GitHub MCP v$providerVersion in $providerTarget. Restart Grok Workbench to update PATH."
} finally {
  $providerResolvedTemp = [IO.Path]::GetFullPath($providerTemp)
  if (!$providerResolvedTemp.StartsWith($providerTempRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary cleanup path.' }
  Remove-Item -LiteralPath $providerResolvedTemp -Recurse -Force
}
