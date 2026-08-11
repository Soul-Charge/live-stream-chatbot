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
from collections import OrderedDict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
CONFIG_PATH = os.path.join(PROJECT_ROOT, "config", "config.json")

with open(CONFIG_PATH, "r", encoding="utf-8") as f:
    genie_cfg = json.load(f).get("genie", {})

HOST = str(genie_cfg.get("host", "127.0.0.1"))
PORT = int(genie_cfg.get("port", 8000))
USE_GPU = bool(genie_cfg.get("useGpu", True))
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


class _FixedLRUCacheDict:
    """
    修复 genie_tts 2.0.2 的 LRUCacheDict 淘汰 bug：

    原实现继承 OrderedDict 并重写 __getitem__，而 OrderedDict.popitem 的 C 实现
    会以 self[key] 的方式取值，淘汰时触发已移除键的 KeyError，并损坏内部状态
    （例如容量 1 时插入第二个键直接抛 KeyError('第一个键')，且 'in' 判断仍为 True）。

    这里改用独立的 OrderedDict 实现等价 LRU 语义，不干扰 OrderedDict 的 C 方法。
    """

    def __init__(self, capacity):
        self.capacity = max(1, int(capacity))
        self._data = OrderedDict()

    def __contains__(self, key):
        return key in self._data

    def __len__(self):
        return len(self._data)

    def __iter__(self):
        return iter(self._data)

    def __getitem__(self, key):
        value = self._data.pop(key)
        self._data[key] = value  # 访问后移到末尾
        return value

    def __setitem__(self, key, value):
        if key in self._data:
            del self._data[key]
        self._data[key] = value
        while len(self._data) > self.capacity:
            self._data.popitem(last=False)  # 删除最旧的

    def __delitem__(self, key):
        del self._data[key]

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def clear(self):
        self._data.clear()

    def keys(self):
        return self._data.keys()

    def values(self):
        return self._data.values()

    def items(self):
        return self._data.items()

    def __repr__(self):
        return repr(self._data)


def _apply_lru_fix():
    from genie_tts import ModelManager as mm

    # 直接替换已创建 singleton 的缓存属性（Server/Internal 引用的都是这个实例）
    mm.model_manager.character_to_model = _FixedLRUCacheDict(MAX_CACHED)
    print(f"[genie] LRUCacheDict bug 修复已应用 (capacity={MAX_CACHED})")


_apply_lru_fix()


def cuda_is_usable() -> bool:
    import onnx
    import onnxruntime
    from onnx import TensorProto, helper

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

    if USE_GPU and cuda_is_usable():
        model_manager.providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        print(f"[genie] GPU OK: CUDAExecutionProvider (onnxruntime {__import__('onnxruntime').__version__})")
    else:
        model_manager.providers = ["CPUExecutionProvider"]
        print("[genie] CUDA unavailable, fallback to CPU")

    print(f"[genie] starting server {HOST}:{PORT}, Max_Cached_Character_Models={MAX_CACHED}")
    genie.start_server(host=HOST, port=PORT, workers=1)


if __name__ == "__main__":
    main()
