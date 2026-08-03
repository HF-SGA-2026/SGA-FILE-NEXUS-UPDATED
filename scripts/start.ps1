$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$venvDirectory = Join-Path $repositoryRoot ".venv"
$venvPython = Join-Path $venvDirectory "Scripts\python.exe"
$requirementsFile = Join-Path $repositoryRoot "requirements.txt"
$requirementsMarker = Join-Path $venvDirectory ".requirements.sha256"
$fastApiUrl = "http://127.0.0.1:8006/"
$nexusUrl = "http://127.0.0.1:8080/api/status"
$startupTimeoutSeconds = 90
$fastApiProcess = $null
$nexusProcess = $null
$script:stopRequested = $false

function Write-Step {
  param([string]$Message)
  [Console]::WriteLine("[Startup] $Message")
}

function Quote-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Join-ProcessArguments {
  param([string[]]$ArgumentList)
  return (($ArgumentList | ForEach-Object { Quote-ProcessArgument $_ }) -join " ")
}

function Test-PythonCandidate {
  param([string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    return $null
  }

  try {
    $probe = New-Object System.Diagnostics.Process
    $probe.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $probe.StartInfo.FileName = $command.Source
    $probe.StartInfo.Arguments = "--version"
    $probe.StartInfo.UseShellExecute = $false
    $probe.StartInfo.CreateNoWindow = $true
    $probe.StartInfo.RedirectStandardOutput = $true
    $probe.StartInfo.RedirectStandardError = $true
    if (-not $probe.Start()) {
      return $null
    }
    if (-not $probe.WaitForExit(10000)) {
      $probe.Kill()
      return $null
    }
    $versionOutput = ($probe.StandardOutput.ReadToEnd() + $probe.StandardError.ReadToEnd()).Trim()
    if ($probe.ExitCode -eq 0 -and $versionOutput -match '^Python\s+\d+') {
      return $command.Source
    }
  } catch {
    return $null
  }

  return $null
}

function Find-Python {
  foreach ($candidate in @("py", "python", "python3")) {
    $pythonPath = Test-PythonCandidate $candidate
    if ($pythonPath) {
      return $pythonPath
    }
  }

  $documentsRoot = Split-Path -Parent (Split-Path -Parent $repositoryRoot)
  $fallbackCandidates = @(
    (Join-Path $documentsRoot "QC\.venv\Scripts\python.exe"),
    (Join-Path $env:USERPROFILE "OneDrive\Documents\QC\.venv\Scripts\python.exe"),
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe")
  )
  foreach ($candidate in $fallbackCandidates) {
    if (Test-PythonExecutable $candidate) {
      return $candidate
    }
  }

  return $null
}

function Invoke-RequiredCommand {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$DisplayCommand
  )

  Write-Step "Running: $DisplayCommand"
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE`: $DisplayCommand"
  }
}

function Test-PythonExecutable {
  param([string]$FilePath)

  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    return $false
  }

  try {
    $probe = New-Object System.Diagnostics.Process
    $probe.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $probe.StartInfo.FileName = $FilePath
    $probe.StartInfo.Arguments = "--version"
    $probe.StartInfo.UseShellExecute = $false
    $probe.StartInfo.CreateNoWindow = $true
    $probe.StartInfo.RedirectStandardOutput = $true
    $probe.StartInfo.RedirectStandardError = $true
    if (-not $probe.Start()) {
      return $false
    }
    if (-not $probe.WaitForExit(10000)) {
      $probe.Kill()
      return $false
    }
    $versionOutput = ($probe.StandardOutput.ReadToEnd() + $probe.StandardError.ReadToEnd()).Trim()
    return $probe.ExitCode -eq 0 -and $versionOutput -match '^Python\s+\d+'
  } catch {
    return $false
  }
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = @($env:Path, $machinePath, $userPath) -join ";"
}

function Install-Python {
  $winget = Get-Command "winget" -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Python is not installed and Windows Package Manager (winget) is unavailable. Install Python 3.12 from https://www.python.org/downloads/windows/ and run npm start again."
  }

  $wingetArguments = @(
    "install",
    "-e",
    "--id", "Python.Python.3.12",
    "--accept-package-agreements",
    "--accept-source-agreements"
  )
  $wingetCommand = "winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements"
  Invoke-RequiredCommand -FilePath $winget.Source -ArgumentList $wingetArguments -DisplayCommand $wingetCommand
  Refresh-ProcessPath
}

function Ensure-VirtualEnvironment {
  param([string]$SystemPython)

  if (Test-PythonExecutable $venvPython) {
    Write-Step "Using existing virtual environment at $venvDirectory"
    return
  }

  if (Test-Path -LiteralPath $venvDirectory) {
    Write-Step "Existing virtual environment is stale or broken. Recreating $venvDirectory"
    Remove-Item -LiteralPath $venvDirectory -Recurse -Force
  }

  Invoke-RequiredCommand -FilePath $SystemPython -ArgumentList @("-m", "venv", $venvDirectory) -DisplayCommand "python -m venv .venv"
  if (-not (Test-PythonExecutable $venvPython)) {
    throw "Virtual environment creation completed without producing '$venvPython'."
  }
}

function Ensure-Requirements {
  if (-not (Test-Path -LiteralPath $requirementsFile -PathType Leaf)) {
    throw "Requirements file not found: $requirementsFile"
  }

  $requirementsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $requirementsFile).Hash
  $installedHash = if (Test-Path -LiteralPath $requirementsMarker) {
    (Get-Content -Raw -LiteralPath $requirementsMarker).Trim()
  } else {
    ""
  }

  if ($requirementsHash -eq $installedHash) {
    Write-Step "Python requirements are already installed."
    return
  }

  $displayCommand = ".venv\Scripts\python.exe -m pip install -r requirements.txt"
  Invoke-RequiredCommand -FilePath $venvPython -ArgumentList @("-m", "pip", "install", "-r", $requirementsFile) -DisplayCommand $displayCommand
  Set-Content -LiteralPath $requirementsMarker -Value $requirementsHash -Encoding ASCII
}

function Test-HttpEndpoint {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Assert-PortAvailable {
  param([string]$Url, [string]$ServiceName)
  if (Test-HttpEndpoint $Url) {
    throw "$ServiceName is already responding at $Url. Stop the existing process using that port, then run npm start again."
  }
}

function Start-LoggedProcess {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [hashtable]$EnvironmentVariables = @{}
  )

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $process.StartInfo.FileName = $FilePath
  $process.StartInfo.Arguments = Join-ProcessArguments $ArgumentList
  $process.StartInfo.WorkingDirectory = $repositoryRoot
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  foreach ($entry in $EnvironmentVariables.GetEnumerator()) {
    $process.StartInfo.EnvironmentVariables[$entry.Key] = [string]$entry.Value
  }

  if (-not $process.Start()) {
    throw "$Name failed to start."
  }
  return [pscustomobject]@{
    Name = $Name
    Process = $process
    OutputTask = $process.StandardOutput.ReadLineAsync()
    ErrorTask = $process.StandardError.ReadLineAsync()
  }
}

function Write-AvailableProcessLogs {
  param($ManagedProcess)
  if ($null -eq $ManagedProcess) {
    return
  }

  while ($null -ne $ManagedProcess.OutputTask -and $ManagedProcess.OutputTask.IsCompleted) {
    $line = $ManagedProcess.OutputTask.Result
    if ($null -eq $line) {
      $ManagedProcess.OutputTask = $null
      break
    }
    [Console]::WriteLine("[$($ManagedProcess.Name)] $line")
    $ManagedProcess.OutputTask = $ManagedProcess.Process.StandardOutput.ReadLineAsync()
  }

  while ($null -ne $ManagedProcess.ErrorTask -and $ManagedProcess.ErrorTask.IsCompleted) {
    $line = $ManagedProcess.ErrorTask.Result
    if ($null -eq $line) {
      $ManagedProcess.ErrorTask = $null
      break
    }
    [Console]::Error.WriteLine("[$($ManagedProcess.Name)] $line")
    $ManagedProcess.ErrorTask = $ManagedProcess.Process.StandardError.ReadLineAsync()
  }
}

function Wait-ForServiceReady {
  param(
    $ManagedProcess,
    [string]$Name,
    [string]$Url,
    [int]$TimeoutSeconds
  )

  Write-Step "Waiting for $Name at $Url"
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    Write-AvailableProcessLogs $ManagedProcess
    if ($ManagedProcess.Process.HasExited) {
      Write-AvailableProcessLogs $ManagedProcess
      throw "$Name exited before becoming ready (exit code $($ManagedProcess.Process.ExitCode))."
    }
    if (Test-HttpEndpoint $Url) {
      Write-AvailableProcessLogs $ManagedProcess
      Write-Step "$Name is ready."
      return
    }
    Start-Sleep -Milliseconds 300
  }
  throw "$Name did not become ready within $TimeoutSeconds seconds at $Url."
}

function Stop-ChildProcess {
  param($ManagedProcess, [string]$Name)
  if ($null -eq $ManagedProcess) {
    return
  }
  $process = $ManagedProcess.Process
  try {
    if (-not $process.HasExited) {
      Write-Step "Stopping $Name..."
      $process.Kill()
      $process.WaitForExit(5000) | Out-Null
    }
    Write-AvailableProcessLogs $ManagedProcess
  } catch {
    [Console]::Error.WriteLine("[Startup] Could not stop $Name cleanly: $($_.Exception.Message)")
  }
}

$cancelHandler = [ConsoleCancelEventHandler]{
  param($sender, $eventArgs)
  $eventArgs.Cancel = $true
  $script:stopRequested = $true
}

try {
  Set-Location -LiteralPath $repositoryRoot
  Write-Step "Preparing SGA File Nexus and QC Integrity Check..."

  Refresh-ProcessPath
  $systemPython = Find-Python
  if (-not $systemPython) {
    Write-Step "Python was not found as py, python, or python3. Installing Python 3.12 with winget..."
    Install-Python
    $systemPython = Find-Python
  }
  if (-not $systemPython) {
    throw "Python installation finished, but Python could not be detected as py, python, or python3. Close this terminal, open a new terminal, and run npm start again."
  }
  Write-Step "Detected Python: $systemPython"

  Ensure-VirtualEnvironment -SystemPython $systemPython
  Ensure-Requirements
  Assert-PortAvailable -Url $fastApiUrl -ServiceName "QC Integrity Check"
  Assert-PortAvailable -Url $nexusUrl -ServiceName "SGA File Nexus"

  [Console]::add_CancelKeyPress($cancelHandler)

  Write-Step "Starting QC Integrity Check on http://127.0.0.1:8006"
  $fastApiProcess = Start-LoggedProcess -Name "QC" -FilePath $venvPython -ArgumentList @(
    "-m", "uvicorn", "web_app:app", "--host", "127.0.0.1", "--port", "8006"
  ) -EnvironmentVariables @{ "PYTHONUNBUFFERED" = "1" }
  Wait-ForServiceReady -ManagedProcess $fastApiProcess -Name "QC Integrity Check" -Url $fastApiUrl -TimeoutSeconds $startupTimeoutSeconds

  Write-Step "Starting SGA File Nexus on http://127.0.0.1:8080"
  $nexusProcess = Start-LoggedProcess -Name "Nexus" -FilePath "node" -ArgumentList @("server.js")
  Wait-ForServiceReady -ManagedProcess $nexusProcess -Name "SGA File Nexus" -Url $nexusUrl -TimeoutSeconds 30
  Write-Step "Both services are ready. Open http://127.0.0.1:8080"
  Write-Step "Press Ctrl+C to stop both services."

  while (-not $script:stopRequested) {
    Write-AvailableProcessLogs $fastApiProcess
    Write-AvailableProcessLogs $nexusProcess
    if ($fastApiProcess.Process.HasExited) {
      throw "QC Integrity Check stopped unexpectedly with exit code $($fastApiProcess.Process.ExitCode)."
    }
    if ($nexusProcess.Process.HasExited) {
      throw "SGA File Nexus stopped unexpectedly with exit code $($nexusProcess.Process.ExitCode)."
    }
    Start-Sleep -Milliseconds 300
  }
} catch {
  [Console]::Error.WriteLine("[Startup] ERROR: $($_.Exception.Message)")
  $global:LASTEXITCODE = 1
} finally {
  Stop-ChildProcess -ManagedProcess $nexusProcess -Name "SGA File Nexus"
  Stop-ChildProcess -ManagedProcess $fastApiProcess -Name "QC Integrity Check"
  try {
    [Console]::remove_CancelKeyPress($cancelHandler)
  } catch {
  }
}

if ($global:LASTEXITCODE -eq 1) {
  exit 1
}
