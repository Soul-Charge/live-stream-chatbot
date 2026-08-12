$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$config = Get-Content -Path (Join-Path $root 'config/config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$apiDir = 'F:/AiSound/GPT-SoVITS-v2pro-20250604'
$python = Join-Path $apiDir 'runtime/python.exe'
$apiOut = Join-Path $env:TEMP 'gpt_sovits_perf_api.out.log'
$apiErr = Join-Path $env:TEMP 'gpt_sovits_perf_api.err.log'
$stalePidFile = Join-Path $env:TEMP 'perf_api.pid'
$reportPath = Join-Path $root 'vibe-coding-reference/gpt-sovits-performance-report.md'
$audioTemp = Join-Path $env:TEMP 'gpt_sovits_perf_audio.wav'

$testText = '你好，欢迎来到直播间，今天天气真不错。'

function Get-GpuSample {
    try {
        $line = & nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits 2>$null
        if ($line) {
            $parts = $line -split ','
            return [pscustomobject]@{ Util = [double]$parts[0]; MemMB = [double]$parts[1] }
        }
    } catch {
    }
    return $null
}

function Test-ApiTcp {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect('127.0.0.1', 9880, $null, $null)
        if ($result.AsyncWaitHandle.WaitOne(2000)) {
            $client.EndConnect($result)
            return $true
        }
    } catch {
    } finally {
        $client.Dispose()
    }
    return $false
}

function Start-RoleSampler([int]$targetPid) {
    $job = Start-Job -ArgumentList $targetPid -ScriptBlock {
        param([int]$pidArg)
        while ($true) {
            $p = Get-Process -Id $pidArg -ErrorAction SilentlyContinue
            $gpu = $null
            try {
                $line = & nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits 2>$null
                if ($line) {
                    $parts = $line -split ','
                    $gpu = [pscustomobject]@{ Util = [double]$parts[0]; MemMB = [double]$parts[1] }
                }
            } catch {
            }
            [pscustomobject]@{
                Time = [DateTime]::UtcNow
                Cpu = if ($p) { [double]$p.CPU } else { $null }
                WsMB = if ($p) { [math]::Round($p.WorkingSet64 / 1MB, 1) } else { $null }
                PrivMB = if ($p) { [math]::Round($p.PrivateMemorySize64 / 1MB, 1) } else { $null }
                GpuUtil = if ($gpu) { $gpu.Util } else { $null }
                GpuMemMB = if ($gpu) { $gpu.MemMB } else { $null }
            } | Write-Output
            Start-Sleep -Seconds 1
        }
    }
    return $job
}

function Stop-RoleSampler($job) {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    $samples = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    return $samples
}

function Get-RoleStats($samples) {
    $stats = [ordered]@{}
    $stats['wallSec'] = 0
    $stats['audioBytes'] = 0
    $stats['cpuPeakPct'] = $null
    $stats['cpuAvgPct'] = $null
    $stats['wsPeakMB'] = 0
    $stats['privPeakMB'] = 0
    $stats['gpuPeakPct'] = 0
    $stats['gpuMemPeakMB'] = 0

    $rates = @()
    for ($i = 1; $i -lt $samples.Count; $i++) {
        $dt = ($samples[$i].Time - $samples[$i - 1].Time).TotalSeconds
        $dcpu = $samples[$i].Cpu - $samples[$i - 1].Cpu
        if ($dt -gt 0 -and $null -ne $dcpu) {
            $rates += [math]::Round(($dcpu / $dt) * 100, 1)
        }
    }
    if ($rates.Count -gt 0) {
        $stats['cpuPeakPct'] = ($rates | Measure-Object -Maximum).Maximum
        $stats['cpuAvgPct'] = [math]::Round(($rates | Measure-Object -Average).Average, 1)
    }
    foreach ($s in $samples) {
        if ($null -ne $s.WsMB -and $s.WsMB -gt $stats['wsPeakMB']) { $stats['wsPeakMB'] = $s.WsMB }
        if ($null -ne $s.PrivMB -and $s.PrivMB -gt $stats['privPeakMB']) { $stats['privPeakMB'] = $s.PrivMB }
        if ($null -ne $s.GpuUtil -and $s.GpuUtil -gt $stats['gpuPeakPct']) { $stats['gpuPeakPct'] = $s.GpuUtil }
        if ($null -ne $s.GpuMemMB -and $s.GpuMemMB -gt $stats['gpuMemPeakMB']) { $stats['gpuMemPeakMB'] = $s.GpuMemMB }
    }
    return $stats
}

$existing = Get-NetTCPConnection -State Listen -LocalPort 9880 -ErrorAction SilentlyContinue
if ($existing) {
    $apiPid = $existing[0].OwningProcess
    $startedByUs = $false
} else {
    if (Test-Path $stalePidFile) {
        $oldPid = [int](Get-Content $stalePidFile)
        if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $oldPid -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
    $apiOutLog = Join-Path $env:TEMP 'gpt_sovits_perf_api.out.log'
    $apiErrLog = Join-Path $env:TEMP 'gpt_sovits_perf_api.err.log'
    Remove-Item $apiOutLog, $apiErrLog -ErrorAction SilentlyContinue
    $apiProc = Start-Process -FilePath $python -ArgumentList @('-u', 'api_v2.py', '-a', '127.0.0.1', '-p', '9880', '-c', 'GPT_SoVITS/configs/tts_infer.yaml') -WorkingDirectory $apiDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $apiOutLog -RedirectStandardError $apiErrLog
    $apiPid = $apiProc.Id
    $startedByUs = $true
}

Set-Content -Path $stalePidFile -Value $apiPid

$apiReady = $false
$startWatch = [Diagnostics.Stopwatch]::StartNew()
while ($startWatch.Elapsed.TotalMinutes -lt 10) {
    if (Test-ApiTcp) {
        $apiReady = $true
        break
    }
    if (-not (Get-Process -Id $apiPid -ErrorAction SilentlyContinue)) {
        throw "GPT-SoVITS API exited before ready. See $apiOutLog and $apiErrLog"
    }
    Start-Sleep -Seconds 5
}
$startWatch.Stop()
if (-not $apiReady) {
    throw "GPT-SoVITS API did not become ready in 10 minutes. See $apiOutLog and $apiErrLog"
}

$startupSec = [math]::Round($startWatch.Elapsed.TotalSeconds, 1)
Write-Output "API ready in ${startupSec}s, PID=$apiPid"

try {
    $rows = @()
    foreach ($roleProp in $config.roles.PSObject.Properties) {
    $roleKey = $roleProp.Name
    $role = $roleProp.Value
    $roleParams = $role.params

    Write-Output "Start role: $roleKey"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $job = Start-RoleSampler $apiPid

    try {
        $gptUrl = 'http://127.0.0.1:9880/set_gpt_weights?weights_path=' + [uri]::EscapeDataString([string]$roleParams.gpt_path)
        $sovitsUrl = 'http://127.0.0.1:9880/set_sovits_weights?weights_path=' + [uri]::EscapeDataString([string]$roleParams.sovits_path)
        Invoke-WebRequest -Uri $gptUrl -TimeoutSec 600 -UseBasicParsing | Out-Null
        Invoke-WebRequest -Uri $sovitsUrl -TimeoutSec 600 -UseBasicParsing | Out-Null

        Remove-Item $audioTemp -ErrorAction SilentlyContinue
        $payload = [ordered]@{
            text = $testText
            text_lang = 'auto'
            ref_audio_path = [string]$role.refAudio
            prompt_text = [string]$role.refText
            prompt_lang = 'ja'
            text_split_method = 'cut0'
            batch_size = 1
            media_type = 'wav'
            streaming_mode = $true
        }
        foreach ($p in $roleParams.PSObject.Properties) {
            $payload[$p.Name] = $p.Value
        }
        $json = $payload | ConvertTo-Json -Compress
        Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:9880/tts' -ContentType 'application/json; charset=utf-8' -Body $json -OutFile $audioTemp -TimeoutSec 600 -UseBasicParsing | Out-Null
    } finally {
        $watch.Stop()
        $samples = @(Stop-RoleSampler $job)
    }

    $stats = Get-RoleStats $samples
    $stats['wallSec'] = [math]::Round($watch.Elapsed.TotalSeconds, 1)
    $stats['audioBytes'] = if (Test-Path $audioTemp) { (Get-Item $audioTemp).Length } else { 0 }
    $rows += [pscustomobject]@{
        Role = $roleKey
        Comment = [string]$role.comment
        Gpt = [string]$roleParams.gpt_path
        WallSec = $stats['wallSec']
        AudioBytes = $stats['audioBytes']
        CpuPeakPct = $stats['cpuPeakPct']
        CpuAvgPct = $stats['cpuAvgPct']
        WsPeakMB = $stats['wsPeakMB']
        PrivPeakMB = $stats['privPeakMB']
        GpuPeakPct = $stats['gpuPeakPct']
        GpuMemPeakMB = $stats['gpuMemPeakMB']
    }
    Write-Output "Done role: $roleKey, wall=$($stats['wallSec'])s, audio=$($stats['audioBytes']) bytes"
    }
} finally {
    if ($startedByUs) {
        Stop-Process -Id $apiPid -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $apiPid -Timeout 10 -ErrorAction SilentlyContinue
    }
    Remove-Item $stalePidFile -ErrorAction SilentlyContinue
}

$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
$header = @(
    '# GPT-SoVITS 性能测试报告'
    ''
    "测试时间：$now"
    '测试方式：直接启动 `api_v2.py`，不经过中间件，不经过播放器'
    "测试文本：$testText"
    "API 启动耗时：${startupSec}s"
    ''
) -join [Environment]::NewLine

$tableHeader = '| 角色 | 注释 | 总耗时(s) | 音频(bytes) | CPU峰值(%) | CPU平均(%) | 工作集峰值(MB) | 私有内存峰值(MB) | GPU峰值(%) | 显存峰值(MB) |'
$tableSep = '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
$tableLines = foreach ($r in $rows) {
    "| $($r.Role) | $($r.Comment) | $($r.WallSec) | $($r.AudioBytes) | $($r.CpuPeakPct) | $($r.CpuAvgPct) | $($r.WsPeakMB) | $($r.PrivPeakMB) | $($r.GpuPeakPct) | $($r.GpuMemPeakMB) |"
}
$content = $header + $tableHeader + $tableSep + $tableLines + '' + 'CPU 峰值按采样间隔 CPU 增量换算，可能超过 100%（多核）。GPU 数据来自 `nvidia-smi`。'
[System.IO.File]::WriteAllText($reportPath, ($content -join [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))

Write-Output "Report written: $reportPath"
