$ErrorActionPreference = 'Stop'
if ($env:GROK_SIGNING_PROVIDER -eq 'azure') {
  foreach ($taskName in @('GROK_SIGNING_ENDPOINT','GROK_SIGNING_ACCOUNT','GROK_SIGNING_PROFILE','GROK_SIGNER_NAME')) { if (-not [Environment]::GetEnvironmentVariable($taskName)) { throw ('Configure ' + $taskName + ' locally. No signing resource is created by this check.') } }
  Write-Output 'Azure signing resource details are present. Configure the selected Azure credential method locally; actual signing must pass post-build verification.'
  exit 0
}
if (-not $env:CSC_LINK -or -not $env:CSC_KEY_PASSWORD -or -not $env:GROK_SIGNER_THUMBPRINT) {
  throw 'Configure CSC_LINK, CSC_KEY_PASSWORD and GROK_SIGNER_THUMBPRINT locally or as CI secrets. Do not commit certificate material.'
}
if ($env:GROK_SIGNER_THUMBPRINT -notmatch '^[a-fA-F0-9]{40}$') { throw 'Invalid expected signer thumbprint.' }
Write-Output 'Signing inputs are present. Actual signature and publisher must pass update-manifest verification after packaging.'
