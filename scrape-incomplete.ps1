# scrape-incomplete.ps1
# Run from the Epic_vibing repo root.
# Runs the full test suite and reports incomplete companies.
# Usage: .\scrape-incomplete.ps1
#        .\scrape-incomplete.ps1 -TimeoutMin 30
#        .\scrape-incomplete.ps1 -Concurrency 5

param(
    [int]$TimeoutMin = 45,
    [int]$Concurrency = 10
)

$resultsPath = "output/results.json"

Write-Host "=== Running full scrape (timeout: ${TimeoutMin}min, concurrency: $Concurrency) ==="
Write-Host "Started: $(Get-Date -Format 'HH:mm:ss')"
Write-Host ""

$proc = Start-Process -FilePath "node" `
    -ArgumentList "scripts/test-all-companies.cjs", "--concurrency", "$Concurrency" `
    -NoNewWindow -PassThru

$finished = $proc.WaitForExit($TimeoutMin * 60 * 1000)

if (-not $finished) {
    try { $proc.Kill() } catch {}
    Write-Host "TIMEOUT after ${TimeoutMin} minutes" -ForegroundColor Yellow
} else {
    Write-Host "Completed with exit code: $($proc.ExitCode)"
}

Write-Host ""
Write-Host "Finished: $(Get-Date -Format 'HH:mm:ss')"
Write-Host ""

# Now report results
if (-not (Test-Path $resultsPath)) {
    Write-Host "No results.json produced!" -ForegroundColor Red
    exit 1
}

$raw = Get-Content $resultsPath -Raw | ConvertFrom-Json
$results = $raw.results

$coreFields = @("revenue_msek", "ebit_msek", "employees", "ceo", "fiscal_year")

$complete = 0
$partial = 0
$failed = 0
$incompleteList = @()

foreach ($co in $results) {
    $data = $co.extractedData
    if (-not $data) {
        $failed++
        $incompleteList += [PSCustomObject]@{
            Company = $co.company
            Ticker = $co.ticker
            Missing = "ALL (no extractedData)"
            MissingCount = 5
        }
        continue
    }

    $missing = @()
    foreach ($field in $coreFields) {
        $val = $data.$field
        if ($null -eq $val -or $val -eq "" -or $val -eq "null") {
            $missing += $field
        }
    }

    if ($missing.Count -eq 0) {
        $complete++
    } else {
        $partial++
        $incompleteList += [PSCustomObject]@{
            Company = $co.company
            Ticker = $co.ticker
            Missing = $missing -join ", "
            MissingCount = $missing.Count
        }
    }
}

$total = $results.Count
$rate = if ($total -gt 0) { [math]::Round($complete / $total, 4) } else { 0 }

Write-Host "=== Results ==="
Write-Host "Total:      $total"
Write-Host "Complete:   $complete" -ForegroundColor Green
Write-Host "Partial:    $partial" -ForegroundColor Yellow
Write-Host "Failed:     $failed" -ForegroundColor Red
Write-Host "Rate:       $rate ($complete/$total)"
Write-Host ""

if ($incompleteList.Count -gt 0) {
    Write-Host "=== Incomplete companies (sorted by easiest wins) ==="
    $incompleteList | Sort-Object MissingCount | Format-Table -AutoSize
}
