"""
启动 Genie-TTS 服务器（阶段 6 自动启动逻辑的独立入口）。

读取 config/config.json 的 genie 配置块：
- host / port：监听地址
- useGpu：优先 CUDAExecutionProvider（不可用时回退 CPU）
- maxCachedCharacters：进程内角色缓存上限（Max_Cached_Character_Models）

用法：
    .\.venv-genie\Scripts\python.exe scripts\start_genie_server.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import genie_fixes

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(PROJECT_ROOT, "config", "config.json")

with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    genie_cfg = json.load(f).get("genie", {})

HOST = str(genie_cfg.get("host", "127.0.0.1"))
PORT = int(genie_cfg.get("port", 8000))
USE_GPU = bool(genie_cfg.get("useGpu", False))
MAX_CACHED = int(genie_cfg.get("maxCachedCharacters", 1))

os.environ["Max_Cached_Character_Models"] = str(MAX_CACHED)


def _prepare_nvidia_dlls():
    """Windows 下把 onnxruntime-gpu 的 nvidia-* pip 包 DLL 目录加入搜索路径。"""
    site_packages = os.path.join(sys.prefix, "Lib", "site-packages")
    nvidia_root = os.path.join(site_packages, "nvidia")
    if not os.path.isdir(nvidia_root):
        return
    dll_dirs = []
    for entry in os.listdir(nvidia_root):
        bin_dir = os.path.join(nvidia_root, entry, "bin")
        if os.path.isdir(bin_dir):
            dll_dirs.append(bin_dir)
            try:
                os.add_dll_directory(bin_dir)
            except Exception:
                pass
    os.environ["PATH"] = os.pathsep.join(dll_dirs + [os.environ.get("PATH", "")])


_prepare_nvidia_dlls()

import genie_tts as genie


genie_fixes.apply_lru_fix(MAX_CACHED)
print(f"[genie] LRUCacheDict bug 修复已应用 (capacity={MAX_CACHED})")


def cuda_is_usable() -> bool:
    import onnx
    import onnxruntime
    from onnx import TensorProto, helper

    if "CUDAExecutionProvider" not in onnxruntime.get_available_providers():
        return False

    node = helper.make_node("Identity", ["X"], ["Y"])
    graph = helper.make_graph(
        [node],
        "cuda_probe",
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 2])],
        [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 2])],
    )
    model = helper.make_model(graph)
    model.ir_version = 10
    model.opset_import[0].version = 17
    session = onnxruntime.InferenceSession(
        model.SerializeToString(),
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    return "CUDAExecutionProvider" in session.get_providers()


def main():
    from genie_tts.ModelManager import model_manager

    if not USE_GPU:
        model_manager.providers = ["CPUExecutionProvider"]
        print("[genie] CPU inference (useGpu=false)")
    elif cuda_is_usable():
        model_manager.providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        print(f"[genie] GPU OK: CUDAExecutionProvider (onnxruntime {__import__('onnxruntime').__version__})")
    else:
        model_manager.providers = ["CPUExecutionProvider"]
        print("[genie] CUDA unavailable, fallback to CPU")

    print(f"[genie] starting server {HOST}:{PORT}, Max_Cached_Character_Models={MAX_CACHED}")
    genie.start_server(host=HOST, port=PORT, workers=1)


if __name__ == "__main__":
    main()
