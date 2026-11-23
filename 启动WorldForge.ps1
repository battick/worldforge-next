$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Join-Path $PSScriptRoot 'app')
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw '请先安装 Node.js 24.19.0 或更高的 24 系列版本。'
    }
    if (-not (Test-Path -LiteralPath 'node_modules/.bin/tsx.cmd')) {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw '构建失败，请查看上方错误。' }
    npm start
} finally {
    Pop-Location
}
