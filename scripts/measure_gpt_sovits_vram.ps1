#Requires -Version 5.1
<#
  V1 显存基线探针：
  启动（或复用）GPT-SoVITS API，分别采样：
    - 启动后空闲（tts_infer.yaml 的 custom 模型）
    - 切换到 config.json 默认角色后的空闲
    - set_weights + /tts 合成窗口峰值（每秒采样）
    - 合成结束指定秒数后的释放情况
  用于确认常驻保持量与 empty_cache 的实际效果。

  注意：本文件必须保存为 UTF-8 with BOM；Windows PowerShell 5.1 依赖 BOM 识别 UTF-8，否则中文注释会乱码。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\measure_gpt_sovits_vram.ps1
    powershell -ExecutionPolicy Bypass -File scripts\measure_gpt_sovits_vram.ps1 -ConfigPath config\config.json -TestText "你好呀"
    powershell -ExecutionPolicy Bypass -File scripts\measure_gpt_sovits_vram.ps1 -IdleWaitSeconds 30 -PostIdleSeconds 10
#>
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config\config.json'),
    [string]$TestText = '你好，欢迎来到直播间，今天天气真不错。',
    [int]$IdleWaitSeconds = 15,
    [int]$PostIdleSeconds = 5
)

$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configPath = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $configPath)) { throw "配置文件不存在: $configPath" }

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$apiDir = [string]$config.gptSoVits.path
if (-not $apiDir) { throw 'config.json 中 gptSoVits.path 为空' }
if (-not (Test-Path -LiteralPath $apiDir)) { throw "GPT-SoVITS 目录不存在: $apiDir" }

# 只接受 origin，避免把 /tts 之类路径拼进 set_weights URL。
$baseUrl = ([string]$config.tts.baseUrl).TrimEnd('/')
if (-not $baseUrl) { throw 'config.json 中 tts.baseUrl 为空' }
$uri = New-Object System.Uri($baseUrl)
if ($uri.Scheme -notin @('http', 'https')) { throw "不支持的 tts.baseUrl 协议: $($uri.Scheme)" }
if ($uri.AbsolutePath -notin @('', '/')) { throw "tts.baseUrl 应只填写 origin，不要包含路径: $baseUrl" }
$port = if ($uri.IsDefaultPort) { if ($uri.Scheme -eq 'https') { 443 } else { 80 } } else { $uri.Port }
$baseUrl = "$($uri.Scheme)://$($uri.Host):$port"
$tcpHost = if ($uri.Host -in @('0.0.0.0', '::', 'localhost')) { '127.0.0.1' } else { $uri.Host }

$roleNames = @($config.roles.PSObject.Properties | ForEach-Object { $_.Name })
if ($roleNames.Count -eq 0) { throw 'config.json 中没有配置任何角色' }
$defaultRoleKey = if ($roleNames -contains 'default') { 'default' } else { $roleNames[0] }
$defaultRole = $config.roles.PSObject.Properties[$defaultRoleKey].Value
if (-not $defaultRole) { throw 'config.json 中没有可用的默认角色（roles.default 为空）' }
$defaultParams = $defaultRole.params
if (-not $defaultParams.gpt_path -or -not $defaultParams.sovits_path) { throw '默认角色缺少 gpt_path / sovits_path' }
if (-not $defaultRole.refAudio -or -not $defaultRole.refText) { throw '默认角色缺少 refAudio / refText' }

$python = Join-Path $apiDir 'runtime\python.exe'
$ttsCfgSource = Join-Path $apiDir 'GPT_SoVITS\configs\tts_infer.yaml'
$apiOut = Join-Path $env:TEMP 'gpt_sovits_vram_api.out.log'
$apiErr = Join-Path $env:TEMP 'gpt_sovits_vram_api.err.log'
$audioTemp = Join-Path $env:TEMP 'gpt_sovits_vram_audio.wav'
$reportPath = Join-Path $root 'vibe-coding-reference\gpt-sovits-vram-baseline.md'

function Get-GpuSample {
    try {
        $line = & nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits 2>$null | Select-Object -First 1
        if ($line) {
            $parts = @($line.Trim() -split ',')
            if ($parts.Count -ge 2) {
                return [pscustomobject]@{ Util = [double]$parts[0]; MemMB = [double]$parts[1] }
            }
        }
    } catch {
    }
    throw '无法读取 nvidia-smi 数据，请确认 nvidia-smi 在 PATH 中且显卡可用'
}

function Get-GpuInfo {
    $line = & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if (-not $line) { return 'unknown, unknown MB' }
    $parts = @($line.Trim() -split ',')
    if ($parts.Count -ge 2) { return "$($parts[0].Trim()), $($parts[1].Trim()) MB" }
    return $line.Trim()
}

function Test-ApiTcp([string]$hostArg, [int]$portArg) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect($hostArg, $portArg, $null, $null)
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

function Test-ApiHttp([string]$baseUrlArg) {
    try {
        $response = Invoke-WebRequest -Uri "$baseUrlArg/docs" -TimeoutSec 5 -UseBasicParsing
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Get-LogTail([string]$path) {
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { return '' }
    return (Get-Content -LiteralPath $path -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
}

function Wait-ApiReady([string]$baseUrlArg, [string]$hostArg, [int]$portArg, [int]$pidArg, [bool]$mustStayAlive) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalMinutes -lt 10) {
        if ($mustStayAlive -and -not (Get-Process -Id $pidArg -ErrorAction SilentlyContinue)) {
            $outTail = Get-LogTail $apiOut
            $errTail = Get-LogTail $apiErr
            throw "GPT-SoVITS API 进程提前退出。`n--- stdout tail ---`n$outTail`n--- stderr tail ---`n$errTail"
        }
        if ((Test-ApiTcp $hostArg $portArg) -and (Test-ApiHttp $baseUrlArg)) {
            return
        }
        Start-Sleep -Seconds 3
    }
    $outTail = Get-LogTail $apiOut
    $errTail = Get-LogTail $apiErr
    throw "GPT-SoVITS API 未在 10 分钟内就绪（TCP 端口或 /docs 探测失败）。`n--- stdout tail ---`n$outTail`n--- stderr tail ---`n$errTail"
}

function Start-MemSampler {
    $job = Start-Job -ScriptBlock {
        while ($true) {
            $sample = $null
            try {
                $line = & nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits 2>$null | Select-Object -First 1
                if ($line) {
                    $parts = @($line.Trim() -split ',')
                    if ($parts.Count -ge 2) {
                        $sample = [pscustomobject]@{
                            Time = [DateTime]::UtcNow
                            Util = [double]$parts[0]
                            MemMB = [double]$parts[1]
                        }
                    }
                }
            } catch {
            }
            if ($sample) { Write-Output $sample }
            Start-Sleep -Seconds 1
        }
    }
    return $job
}

function Stop-MemSampler($job) {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    $samples = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    if ($samples.Count -eq 0) {
        throw '切换/合成期间没有采到任何 GPU 样本，nvidia-smi 可能不可用或采样任务启动失败'
    }
    return $samples
}

function Get-PeakStats($samples) {
    $peakMem = 0.0
    $peakUtil = 0.0
    foreach ($s in $samples) {
        if ($s.MemMB -gt $peakMem) { $peakMem = [double]$s.MemMB }
        if ($s.Util -gt $peakUtil) { $peakUtil = [double]$s.Util }
    }
    return [pscustomobject]@{
        PeakMemMB = $peakMem
        PeakUtil = $peakUtil
        SampleCount = @($samples).Count
    }
}

$startedByUs = $false
$apiPid = $null
$apiProc = $null
$apiKind = ''
$tempCfg = ''
$apiCfgPath = $ttsCfgSource
$cfgRestoreBackup = ''

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
    $apiPid = [int]$listeners[0].OwningProcess
    $proc = Get-Process -Id $apiPid -ErrorAction SilentlyContinue
    if (-not $proc) { throw "端口 $port 被监听，但进程 PID=$apiPid 不存在；请释放端口后重试" }

    $procPath = ''
    $cmdLine = ''
    try { $procPath = $proc.Path } catch { }
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$apiPid" -ErrorAction SilentlyContinue
        if ($cim) { $cmdLine = [string]$cim.CommandLine }
    } catch { }

    if ($cmdLine -and $cmdLine -notmatch 'api_v2\.py') {
        throw "端口 $port 上的 PID=$apiPid 不是 api_v2.py（命令行: $cmdLine）。请关闭该进程或更换 tts.baseUrl 端口。"
    }

    # 复用进程时，set_weights 会通过 save_configs() 写回其 -c 配置文件；先备份，结束后恢复。
    if ($cmdLine -match '-c\s+"?([^"\s]+)"?') {
        $candidate = [string]$matches[1]
        if ($candidate) { $apiCfgPath = [System.IO.Path]::GetFullPath((Join-Path $apiDir $candidate)) }
    }
    if (Test-Path -LiteralPath $apiCfgPath) {
        $cfgRestoreBackup = Join-Path $env:TEMP ('gpt_sovits_tts_infer_' + [guid]::NewGuid().ToString('N') + '.yaml')
        Copy-Item -LiteralPath $apiCfgPath -Destination $cfgRestoreBackup
        Write-Output "已备份复用 API 的配置文件: $apiCfgPath -> $cfgRestoreBackup"
    } else {
        Write-Output "未找到复用 API 的配置文件（将无法恢复 set_weights 写回）: $apiCfgPath"
    }

    Write-Output "复用现有 API 进程 PID=$apiPid（$procPath）"
    $apiKind = 'reused'
    Wait-ApiReady $baseUrl $tcpHost $port $apiPid $true
} else {
    if (-not (Test-Path -LiteralPath $python)) { throw "找不到 Python 解释器: $python" }
    if (-not (Test-Path -LiteralPath $ttsCfgSource)) { throw "找不到 TTS 配置: $ttsCfgSource" }

    # 用临时 yaml 启动，避免 set_weights 的 save_configs() 改写真实 tts_infer.yaml。
    $tempCfg = Join-Path $env:TEMP ('gpt_sovits_tts_infer_' + [guid]::NewGuid().ToString('N') + '.yaml')
    Copy-Item -LiteralPath $ttsCfgSource -Destination $tempCfg
    Write-Output "已复制 TTS 配置到临时文件: $tempCfg"

    # 不注入 expandable_segments：本机 torch 2.0.0 不支持，会报 Unrecognized CachingAllocator option。
    Remove-Item Env:PYTORCH_CUDA_ALLOC_CONF -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $apiOut, $apiErr -ErrorAction SilentlyContinue
    $quotedCfg = '"' + $tempCfg + '"'
    $apiProc = Start-Process -FilePath $python `
        -ArgumentList @('-u', 'api_v2.py', '-a', $uri.Host, '-p', "$port", '-c', $quotedCfg) `
        -WorkingDirectory $apiDir -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $apiOut -RedirectStandardError $apiErr
    $apiPid = $apiProc.Id
    $startedByUs = $true
    $apiKind = 'started'
    Write-Output "已启动 API 进程 PID=$apiPid"
}

try {
    $readyWatch = [Diagnostics.Stopwatch]::StartNew()
    Wait-ApiReady $baseUrl $tcpHost $port $apiPid $startedByUs
    $readyWatch.Stop()
    $apiReadySeconds = [math]::Round($readyWatch.Elapsed.TotalSeconds, 1)

    Write-Output "API 就绪（${apiReadySeconds}s），空闲等待 ${IdleWaitSeconds}s 后采样启动后空闲..."
    Start-Sleep -Seconds $IdleWaitSeconds
    $startupIdleSamples = @()
    for ($i = 0; $i -lt 3; $i++) {
        $startupIdleSamples += Get-GpuSample
        Start-Sleep -Seconds 1
    }
    $startupIdle = $startupIdleSamples[-1]

    Write-Output "启动后空闲: $($startupIdle.MemMB) MB / $($startupIdle.Util)%"
    Write-Output "开始切换默认角色并采样「set_weights + /tts」窗口峰值..."
    $job = Start-MemSampler
    # 给 Start-Job 的 PowerShell 进程留出启动时间，避免漏采 set_weights 早期峰值。
    Start-Sleep -Seconds 2

    try {
        $gptUrl = "$baseUrl/set_gpt_weights?weights_path=" + [uri]::EscapeDataString([string]$defaultParams.gpt_path)
        $sovitsUrl = "$baseUrl/set_sovits_weights?weights_path=" + [uri]::EscapeDataString([string]$defaultParams.sovits_path)
        Invoke-WebRequest -Uri $gptUrl -TimeoutSec 600 -UseBasicParsing | Out-Null
        Invoke-WebRequest -Uri $sovitsUrl -TimeoutSec 600 -UseBasicParsing | Out-Null

        Write-Output "权重切换完成，等待 ${IdleWaitSeconds}s 后采样默认角色空闲..."
        Start-Sleep -Seconds $IdleWaitSeconds
        $switchedIdleSamples = @()
        for ($i = 0; $i -lt 3; $i++) {
            $switchedIdleSamples += Get-GpuSample
            Start-Sleep -Seconds 1
        }
        $switchedIdle = $switchedIdleSamples[-1]
        Write-Output "默认角色空闲: $($switchedIdle.MemMB) MB / $($switchedIdle.Util)%"

        Remove-Item -LiteralPath $audioTemp -ErrorAction SilentlyContinue
        $payload = [ordered]@{
            text = $TestText
            text_lang = [string]$config.tts.textLang
            ref_audio_path = [string]$defaultRole.refAudio
            prompt_text = [string]$defaultRole.refText
            prompt_lang = [string]$config.tts.promptLang
            text_split_method = [string]$config.tts.textSplitMethod
            batch_size = [int]$config.tts.batchSize
            media_type = [string]$config.tts.mediaType
            streaming_mode = [bool]$config.tts.streamingMode
        }
        foreach ($p in $defaultParams.PSObject.Properties) {
            $payload[$p.Name] = $p.Value
        }
        $json = $payload | ConvertTo-Json -Compress
        Invoke-WebRequest -Method Post -Uri "$baseUrl/tts" -ContentType 'application/json; charset=utf-8' -Body $json -OutFile $audioTemp -TimeoutSec 600 -UseBasicParsing | Out-Null
    } finally {
        $samples = @(Stop-MemSampler $job)
    }

    $stats = Get-PeakStats $samples
    Write-Output "合成结束，等待 ${PostIdleSeconds}s 后采样释放情况..."
    Start-Sleep -Seconds $PostIdleSeconds
    $afterSamples = @()
    for ($i = 0; $i -lt 3; $i++) {
        $afterSamples += Get-GpuSample
        Start-Sleep -Seconds 1
    }
    $after = $afterSamples[-1]

    $audioBytes = 0
    if (Test-Path -LiteralPath $audioTemp) { $audioBytes = (Get-Item -LiteralPath $audioTemp).Length }
    $apiKindText = if ($apiKind -eq 'started') { "由本探针启动（PID=$apiPid，结束前会停止）" } else { "复用已有进程（PID=$apiPid）" }
    $allocConfText = if ($apiKind -eq 'started') { '未注入（torch 2.0.0 不支持 expandable_segments）' } else { '未由本脚本注入（继承复用进程）' }
    $gpuInfo = Get-GpuInfo
    $streamingNote = if ([bool]$config.tts.streamingMode) {
        '- 注意：`streaming_mode=true` 下载的是「WAV 头 + PCM 分片」流式拼接，不是标准完整 WAV，`audioBytes` 仅作参考。'
    } else {
        ''
    }

    $lines = @(
        '# GPT-SoVITS 显存基线报告'
        ''
        "测试时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
        ''
        '## 测试口径'
        ''
        '- 直接调用 `api_v2.py`，不经过中间件与播放器。'
        "- API 进程：$apiKindText"
        "- API 就绪耗时：${apiReadySeconds}s；GPU：$gpuInfo"
        "- 空闲等待：${IdleWaitSeconds}s；合成后等待：${PostIdleSeconds}s；峰值窗口样本数：$($stats.SampleCount)"
        "- PYTORCH_CUDA_ALLOC_CONF：$allocConfText"
        "- 测试文本：$TestText"
        "- 合成角色：$defaultRoleKey（$($defaultRole.comment)）"
        "- 默认角色权重：$($defaultParams.gpt_path) / $($defaultParams.sovits_path)"
        "- 合成参数：text_split_method=$($config.tts.textSplitMethod), streaming_mode=$($config.tts.streamingMode)"
        '- 峰值窗口口径：从 set_gpt_weights 开始，到 /tts 响应读完结束（含权重切换与合成）。'
        $streamingNote
        ''
        '## 结果'
        ''
        '| 指标 | 数值 |'
        '| --- | ---: |'
        "| 启动后空闲显存（tts_infer.yaml custom 模型） | $($startupIdle.MemMB) MB |"
        "| 启动后空闲 GPU 利用率 | $($startupIdle.Util) % |"
        "| 切换到默认角色后空闲显存 | $($switchedIdle.MemMB) MB |"
        "| 切换到默认角色后空闲 GPU 利用率 | $($switchedIdle.Util) % |"
        "| 切换 + 合成窗口显存峰值 | $($stats.PeakMemMB) MB |"
        "| 切换 + 合成窗口 GPU 利用率峰值 | $($stats.PeakUtil) % |"
        "| 合成结束 ${PostIdleSeconds}s 后显存 | $($after.MemMB) MB |"
        "| 合成结束 ${PostIdleSeconds}s 后 GPU 利用率 | $($after.Util) % |"
        "| 音频大小 | $audioBytes bytes |"
        ''
        ("> 合成后回落到约 {0} MB；应与「切换到默认角色后空闲」{1} MB 对比，两者接近说明 empty_cache 常驻回收有效。" -f $after.MemMB, $switchedIdle.MemMB)
    )
    [System.IO.File]::WriteAllText($reportPath, ($lines -join [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "报告已写入: $reportPath"
} finally {
    if ($startedByUs -and $apiProc) {
        $apiProc.Refresh()
        if (-not $apiProc.HasExited) {
            Stop-Process -Id $apiPid -Force -ErrorAction SilentlyContinue
            for ($i = 0; $i -lt 10 -and (Get-Process -Id $apiPid -ErrorAction SilentlyContinue); $i++) {
                Start-Sleep -Milliseconds 500
            }
            Write-Output "已停止本次探针启动的 API 进程 PID=$apiPid"
        }
    }

    # 恢复复用 API 的真实 tts_infer 配置，避免 set_weights 永久改写它。
    if ($cfgRestoreBackup -and (Test-Path -LiteralPath $cfgRestoreBackup)) {
        try {
            Copy-Item -LiteralPath $cfgRestoreBackup -Destination $apiCfgPath -Force
            Remove-Item -LiteralPath $cfgRestoreBackup -ErrorAction SilentlyContinue
            Write-Output "已恢复复用 API 的配置文件: $apiCfgPath"
        } catch {
            Write-Warning "恢复配置文件失败，请手动从备份恢复: $cfgRestoreBackup"
        }
    }

    if ($tempCfg -and (Test-Path -LiteralPath $tempCfg)) {
        Remove-Item -LiteralPath $tempCfg -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $audioTemp -ErrorAction SilentlyContinue
}
