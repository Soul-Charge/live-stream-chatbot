# 以可见窗口启动 Genie 服务器，同时把输出写入 logs/genie_server.out.log
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
& "$root\.venv-genie\Scripts\python.exe" scripts\start_genie_server.py 2>&1 |
    Tee-Object -FilePath "$root\logs\genie_server.out.log"
