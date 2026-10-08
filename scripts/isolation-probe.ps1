$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRoot = Join-Path $taskWorkspace ('.test-data/isolation-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $taskRoot | Out-Null
$taskCompiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $taskCompiler /nologo /target:exe ("/out:" + (Join-Path $taskRoot 'probe.exe')) (Join-Path $taskWorkspace 'native/isolation-probe/Probe.cs')
if ($LASTEXITCODE) { throw 'Probe compilation failed.' }
& (Join-Path $taskRoot 'probe.exe') $taskRoot
if ($LASTEXITCODE) { throw 'AppContainer probe failed. Workbench isolation is not established.' }
$taskResult = Get-Content -LiteralPath (Join-Path $taskRoot 'result.json') -Raw | ConvertFrom-Json
if (-not $taskResult.allowedRead -or -not $taskResult.allowedWrite -or -not $taskResult.privateReadDenied -or -not $taskResult.privateWriteDenied -or -not $taskResult.loopbackDenied) { throw 'Probe boundaries did not all pass.' }
Write-Output ('AppContainer scoped ACL/network probe passed: ' + $taskRoot)
