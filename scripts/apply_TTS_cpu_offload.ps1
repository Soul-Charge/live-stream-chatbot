#Requires -Version 5.1
<#
  应用/回滚 V3 CPU 卸载补丁（BERT / CNHubert / SV 常驻 CPU）。

  注意：本文件必须保存为 UTF-8 with BOM；Windows PowerShell 5.1 依赖 BOM 识别 UTF-8，否则中文注释会乱码。

  - 不要求目标目录是 git 仓库，也不要求 PATH 里有 git：脚本直接解析 unified diff 逐 hunk 校验并替换。
  - 用原始/已打补丁两份 SHA256 识别状态，回滚前校验当前文件与备份，避免覆盖错误文件。
  - 备份与状态文件：
      <TTS.py>.v3-cpu-offload.bak
      <TTS.py>.v3-cpu-offload.json

  用法：
    pwsh -File scripts/apply_TTS_cpu_offload.ps1
    pwsh -File scripts/apply_TTS_cpu_offload.ps1 -GptSoVitsPath F:\AiSound\GPT-SoVITS-v2pro-20250604
    pwsh -File scripts/apply_TTS_cpu_offload.ps1 -DryRun
    pwsh -File scripts/apply_TTS_cpu_offload.ps1 -Rollback
    pwsh -File scripts/apply_TTS_cpu_offload.ps1 -Force   # 仅当 TTS.py 版本漂移但确认 hunk 兼容时使用
#>
param(
    [string]$GptSoVitsPath = '',
    [switch]$Rollback,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# 与 scripts/TTS_cpu_offload_v2pro.patch 对应的已知版本（LF、UTF-8 无 BOM）。
$KnownOriginalTextSha = '83a849f2d0accc8a9d51e7ad1cb7475fa135eb7952de8dfae377ea95e5d85c09'
$KnownPatchedTextSha = 'e9e67bb3d732a0fd93d651de735d76577dee40733c81b5f1d94320e13904a25f'
$ExpectedPatchTarget = 'GPT_SoVITS/TTS_infer_pack/TTS.py'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $GptSoVitsPath) {
    $configPath = Join-Path $repoRoot 'config\config.json'
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $GptSoVitsPath = [string]$config.gptSoVits.path
    }
}
if (-not $GptSoVitsPath) { throw '未指定 GPT-SoVITS 目录，且 config.json 中没有 gptSoVits.path' }
if (-not (Test-Path -LiteralPath $GptSoVitsPath)) { throw "GPT-SoVITS 目录不存在: $GptSoVitsPath" }

$target = Join-Path $GptSoVitsPath 'GPT_SoVITS\TTS_infer_pack\TTS.py'
$backup = "$target.v3-cpu-offload.bak"
$statePath = "$target.v3-cpu-offload.json"
$patch = Join-Path $repoRoot 'scripts\TTS_cpu_offload_v2pro.patch'

if (-not (Test-Path -LiteralPath $target)) { throw "找不到 TTS.py: $target" }
if (-not (Test-Path -LiteralPath $patch)) { throw "找不到补丁文件: $patch" }

function Get-FileSha256([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { throw "文件不存在，无法计算 SHA256: $path" }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256([string]$text) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Read-StateFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-HunkList {
    param([string]$PatchPath)

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $lines = [System.IO.File]::ReadAllLines($PatchPath, $utf8NoBom)
    if ($lines.Count -lt 4) { throw '补丁文件内容不足' }
    if ($lines[0] -notmatch '^--- a/') { throw '补丁缺少 --- a/ 文件头' }
    if ($lines[1] -notmatch '^\+\+\+ b/') { throw '补丁缺少 +++ b/ 文件头' }

    $relative = $lines[1].Substring(6).Trim()
    if ($relative -ne $ExpectedPatchTarget) {
        throw "补丁目标路径与预期不一致: $relative"
    }

    $hunks = New-Object System.Collections.ArrayList
    $index = 2
    while ($index -lt $lines.Count) {
        $line = $lines[$index]
        if ($line -notlike '@@ * @@*') {
            if ($line.Trim().Length -gt 0) { throw "无法解析补丁行 $($index + 1): $line" }
            $index += 1
            continue
        }

        $oldLines = New-Object System.Collections.Generic.List[string]
        $newLines = New-Object System.Collections.Generic.List[string]
        $index += 1
        while ($index -lt $lines.Count -and $lines[$index] -notlike '@@ * @@*') {
            $hunkLine = $lines[$index]
            if ($hunkLine.StartsWith(' ')) {
                $text = $hunkLine.Substring(1)
                $oldLines.Add($text)
                $newLines.Add($text)
            } elseif ($hunkLine.StartsWith('-')) {
                $oldLines.Add($hunkLine.Substring(1))
            } elseif ($hunkLine.StartsWith('+')) {
                $newLines.Add($hunkLine.Substring(1))
            } elseif ($hunkLine.StartsWith('\')) {
                # 「\ No newline at end of file」 标记；当前补丁未使用，忽略。
            } elseif ($hunkLine.Length -eq 0) {
                $oldLines.Add('')
                $newLines.Add('')
            } else {
                throw "无法解析补丁 hunk 行 $($index + 1): $hunkLine"
            }
            $index += 1
        }

        if ($oldLines.Count -eq 0 -and $newLines.Count -eq 0) {
            throw "补丁 hunk 为空: $line"
        }

        $null = $hunks.Add([pscustomobject]@{
            Header = $line
            OldBlock = ($oldLines -join "`n")
            NewBlock = ($newLines -join "`n")
        })
    }

    if ($hunks.Count -eq 0) { throw '补丁中没有可应用的 hunk' }
    Write-Output -NoEnumerate $hunks
}

function ConvertTo-Lf {
    param([string]$Text)
    return $Text.Replace("`r`n", "`n").Replace("`r", "`n")
}

function Write-StateFile([string]$path, $data) {
    $json = $data | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------- 回滚 ----------------
if ($Rollback) {
    if (-not (Test-Path -LiteralPath $backup)) { throw "未找到备份文件: $backup" }
    $currentHash = Get-FileSha256 $target
    $backupHash = Get-FileSha256 $backup
    $state = Read-StateFile $statePath

    $expectedPatchedHash = $KnownPatchedTextSha
    $expectedOriginalHash = $KnownOriginalTextSha
    if ($state -and $state.patchedSha256 -and $state.originalSha256) {
        $expectedPatchedHash = [string]$state.patchedSha256
        $expectedOriginalHash = [string]$state.originalSha256
        Write-Host "使用状态文件校验回滚: $statePath"
    } else {
        Write-Host '未找到有效状态文件，使用内置已知 SHA256 校验回滚。'
    }

    if ($currentHash -ne $expectedPatchedHash) {
        throw "拒绝回滚：当前 TTS.py 不匹配已打补丁版本。`n  当前: $currentHash`n  期望: $expectedPatchedHash"
    }
    if ($backupHash -ne $expectedOriginalHash) {
        throw "拒绝回滚：备份文件不匹配原始版本。`n  备份: $backupHash`n  期望: $expectedOriginalHash"
    }

    if ($DryRun) {
        Write-Host "[DryRun] 校验通过，将使用备份覆盖: $target"
        exit 0
    }

    Copy-Item -LiteralPath $backup -Destination $target -Force
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
    Write-Host "已回滚 V3 CPU 卸载补丁: $target"
    Write-Host "备份仍保留: $backup（确认无误后可手动删除）"
    exit 0
}

# ---------------- 应用 ----------------
$content = [System.IO.File]::ReadAllText($target, (New-Object System.Text.UTF8Encoding($false)))
$normalized = ConvertTo-Lf $content
$currentTextHash = Get-TextSha256 $normalized

if ($currentTextHash -eq $KnownPatchedTextSha) {
    Write-Host 'TTS.py 已与已知打补丁版本一致，无需重复应用。'
    exit 0
}

$isKnownOriginal = $currentTextHash -eq $KnownOriginalTextSha
if (-not $isKnownOriginal) {
    if (-not $Force) {
        throw "TTS.py 内容与已知原始版本不一致（SHA256=$currentTextHash）。`n请确认 GPT-SoVITS 版本与补丁匹配；如确认兼容，可加 -Force 按 hunk 精确匹配尝试。"
    }
    Write-Host '警告：TTS.py 与已知版本不一致，-Force 已指定，将继续按 hunk 精确匹配。'
}

$hunks = Get-HunkList $patch

# 版本检查：每个旧 hunk 必须且只能出现一次。
foreach ($hunk in $hunks) {
    $count = [regex]::Matches($normalized, [regex]::Escape($hunk.OldBlock)).Count
    if ($count -ne 1) {
        throw "补丁 hunk 匹配失败（出现 $count 次）: $($hunk.Header)`n请确认 GPT-SoVITS 版本与补丁匹配。"
    }
}

$patched = $normalized
foreach ($hunk in $hunks) {
    $patched = $patched.Replace($hunk.OldBlock, $hunk.NewBlock)
}
foreach ($hunk in $hunks) {
    if (-not $patched.Contains($hunk.NewBlock)) {
        throw "补丁应用后校验失败: $($hunk.Header)"
    }
}

$patchedTextHash = Get-TextSha256 $patched
if ($patchedTextHash -ne $KnownPatchedTextSha) {
    if (-not $Force) {
        throw "补丁应用结果与已知补丁版本不一致（SHA256=$patchedTextHash），已中止且未写盘。"
    }
    Write-Host "警告：应用结果与已知补丁版本不一致（SHA256=$patchedTextHash），-Force 已指定，仍将写盘。"
}

if ($DryRun) {
    Write-Host "[DryRun] 补丁可安全应用，共 $($hunks.Count) 个 hunk。"
    Write-Host "目标: $target"
    exit 0
}

# 备份：固定备份仅当「当前就是已知原始版本且备份也是原始版本」时复用；
# 版本漂移时另建时间戳备份，避免覆盖有效旧备份。
$backupToUse = $backup
$backupCreated = $false
if (Test-Path -LiteralPath $backup) {
    $existingBackupHash = Get-FileSha256 $backup
    if ($isKnownOriginal -and $existingBackupHash -eq $KnownOriginalTextSha) {
        Write-Host "复用已有原始备份: $backup"
    } else {
        $backupToUse = "$target.v3-cpu-offload-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak'
        Copy-Item -LiteralPath $target -Destination $backupToUse
        $backupCreated = $true
        Write-Host "已有备份与当前版本不匹配，新建版本备份: $backupToUse"
    }
} else {
    Copy-Item -LiteralPath $target -Destination $backupToUse
    $backupCreated = $true
    Write-Host "已创建原始备份: $backupToUse"
}

$originalFileHash = Get-FileSha256 $backupToUse

# 保持目标文件原有换行风格（当前 TTS.py 为 LF）。
$newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
$output = if ($newline -eq "`r`n") { $patched.Replace("`n", "`r`n") } else { $patched }
[System.IO.File]::WriteAllText($target, $output, (New-Object System.Text.UTF8Encoding($false)))

$patchedFileHash = Get-FileSha256 $target
$stateData = [ordered]@{
    patchFile = (Split-Path -Leaf $patch)
    appliedAtUtc = [DateTime]::UtcNow.ToString('o')
    targetFile = $target
    backupPath = $backupToUse
    originalSha256 = $originalFileHash
    patchedSha256 = $patchedFileHash
    patchedTextSha256 = $patchedTextHash
}
Write-StateFile $statePath $stateData

Write-Host "V3 CPU 卸载补丁已应用（$($hunks.Count) 个 hunk）: $target"
Write-Host "状态文件: $statePath"
Write-Host '重启 GPT-SoVITS API 后生效。'
