# 以可见窗口启动弹幕中间件，同时把输出写入 logs/middleware.out.log
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
node src\index.js 2>&1 |
    Tee-Object -FilePath "$root\logs\middleware.out.log"
