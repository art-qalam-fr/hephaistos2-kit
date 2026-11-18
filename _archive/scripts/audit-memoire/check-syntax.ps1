foreach ($f in '<TOOLS_ROOT>\Hephaistos-Kit\.agent\scripts\ingest-workspace.ps1','<TOOLS_ROOT>\Hephaistos-Kit\.agent\scripts\start-workspace.ps1','<TOOLS_ROOT>\Hephaistos-Kit\.agent\scripts\memory-maintenance.ps1') {
  $errs = $null
  $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content $f -Raw), [ref]$errs)
  Write-Output ("{0} : {1} erreur(s)" -f (Split-Path $f -Leaf), $errs.Count)
  $errs | ForEach-Object { Write-Output ("  " + $_.Message) }
}
