"""
阶段 4：CPU 多角色缓存内存实测。

在一个进程内依次 load_character 全部 5 个角色（capacity 可指定，默认 5），
打印每个角色的加载耗时与进程内存（WorkingSet），用于决定 maxCachedCharacters。

用法：
    .\.venv-genie\Scripts\python.exe scripts\phase4_memory_test.py [capacity]
"""

import ctypes
import os
import sys
import time
from ctypes import wintypes

capacity = int(sys.argv[1]) if len(sys.argv) > 1 else 5
os.environ["Max_Cached_Character_Models"] = str(capacity)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import genie_fixes

genie_fixes.apply_lru_fix(capacity)

from convert_to_onnx import CHARACTERS, OUTPUT_ROOT
from genie_tts.ModelManager import model_manager


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def process_ram_mb() -> float:
    c = PROCESS_MEMORY_COUNTERS()
    c.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
    get_current_process = ctypes.windll.kernel32.GetCurrentProcess
    get_current_process.restype = ctypes.c_void_p
    get_memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
    get_memory_info.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
        ctypes.c_ulong,
    ]
    ok = get_memory_info(get_current_process(), ctypes.byref(c), c.cb)
    if not ok:
        raise ctypes.WinError()
    return c.WorkingSetSize / 1024 / 1024


def main():
    print(f"capacity={capacity}，开始依次加载 {len(CHARACTERS)} 个角色...")
    base_ram = process_ram_mb()
    print(f"初始进程内存: {base_ram:.0f} MB")

    results = []
    for chara in CHARACTERS:
        name = chara["characterName"]
        model_dir = os.path.join(OUTPUT_ROOT, name, "tts_models")
        t0 = time.time()
        ok = model_manager.load_character(name.lower(), model_dir, chara["language"])
        elapsed = time.time() - t0
        ram = process_ram_mb()
        results.append((name, ok, elapsed, ram))
        print(f"[{'OK' if ok else 'FAIL'}] {name}: 加载 {elapsed:.1f}s, 进程内存 {ram:.0f} MB")

    print("\n===== 汇总 =====")
    for name, ok, elapsed, ram in results:
        print(f"  {'✅' if ok else '❌'} {name}: {elapsed:.1f}s")
    total_ram = process_ram_mb()
    print(f"全部加载后进程内存: {total_ram:.0f} MB（新增 {total_ram - base_ram:.0f} MB）")
    print(f"平均每角色新增: {(total_ram - base_ram) / max(len(results), 1):.0f} MB")
    sys.exit(0 if all(ok for _, ok, _, _ in results) else 1)


if __name__ == "__main__":
    main()
