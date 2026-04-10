Set-Location "$PSScriptRoot"
Write-Host "Starting Solar System Simulator..." -ForegroundColor Cyan
Write-Host "Open http://localhost:5173 in your browser" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor DarkGray
Write-Host ""
Start-Process "http://localhost:5173"
npm run dev
