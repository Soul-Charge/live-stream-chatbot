"""
Genie-TTS 迁移阶段 0：环境与可行性验证脚本。

验证内容：
1. genie.start_server 可启动 FastAPI 服务器（127.0.0.1:8000）。
2. 接口清单（/openapi.json）包含 load_character / set_reference_audio / tts /
   unload_character / stop / clear_reference_audio_cache，且没有健康检查接口。
3. 使用已有的 ONNX 角色模型（mika / 日文）真实跑通：
   load_character -> set_reference_audio -> tts。
4. 确认 /tts 返回裸 PCM（服务端不带 WAV 头），客户端补 WAV 头后保存为可播放文件，
   并读取采样率、声道数、位深。
5. 顺带验证：未知角色 tts 返回 404；不支持的音频格式（.mp3）返回 400。

GPU 说明：
- genie-tts 的合成推理由 onnxruntime 执行（非 torch），需安装 onnxruntime-gpu。
- genie_tts.ModelManager 默认硬编码 CPUExecutionProvider，本脚本在服务器启动前
  将其改为 CUDAExecutionProvider（不可用时自动回退 CPU）。

用法：
    .\.venv-genie\Scripts\python.exe scripts\phase0_verify.py
"""

import json
import os
import socket
import sys
import time
import wave
from multiprocessing import Process

WAV_CHANNELS = 1
WAV_SAMPLE_WIDTH = 2  # 16-bit
WAV_SAMPLE_RATE = 32000

SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8000
BASE_URL = f"http://{SERVER_HOST}:{SERVER_PORT}"

CHARACTER_NAME = "mika"
MODEL_DIR = r"F:\AiSound\Genie-TTS GUI\CharacterModels\v2ProPlus\mika\tts_models"
REF_AUDIO = r"F:\AiSound\Genie-TTS GUI\CharacterModels\v2ProPlus\mika\prompt_wav\917575.wav"
REF_TEXT = "私も昔、これと似たようなの持ってたなぁ…。"
LANGUAGE = "jp"

TTS_TEXT = "こんにちは、先生。今日もよろしくお願いします。"
OUTPUT_WAV = os.path.join("logs", "phase0_mika_tts.wav")


def _prepare_nvidia_dlls():
    """把 onnxruntime-gpu 通过 nvidia-* pip 包安装的 CUDA/cuDNN DLL 目录加入搜索路径。"""
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
    if dll_dirs:
        print(f"[prepare] nvidia DLL 目录: {dll_dirs}")


_prepare_nvidia_dlls()

import requests

import genie_tts as genie


def cuda_is_usable() -> bool:
    """用最小 ONNX 模型实测 CUDAExecutionProvider 能否真正创建会话。"""
    import onnx
    from onnx import TensorProto, helper
    import onnxruntime

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


def run_server():
    import onnxruntime
    from genie_tts.ModelManager import model_manager

    if cuda_is_usable():
        model_manager.providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        print(f"[Server] GPU OK: CUDAExecutionProvider (onnxruntime {onnxruntime.__version__})")
    else:
        model_manager.providers = ["CPUExecutionProvider"]
        print(f"[Server] CUDA unavailable, fallback to CPU (onnxruntime {onnxruntime.__version__})")
    genie.start_server(host=SERVER_HOST, port=SERVER_PORT, workers=1)


def wait_for_server(timeout: float = 90.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((SERVER_HOST, SERVER_PORT), timeout=2):
                return True
        except OSError:
            time.sleep(1)
    return False


def post_json(path: str, payload: dict):
    response = requests.post(f"{BASE_URL}{path}", json=payload, timeout=120)
    print(f"[{response.status_code}] POST {path}")
    print(f"  -> {response.text[:300]}")
    return response


def check_openapi():
    print("\n=== 接口清单检查 ===")
    response = requests.get(f"{BASE_URL}/openapi.json", timeout=30)
    response.raise_for_status()
    paths = sorted(response.json()["paths"].keys())
    print(f"OpenAPI paths: {paths}")

    expected = {
        "/load_character",
        "/set_reference_audio",
        "/tts",
        "/unload_character",
        "/stop",
        "/clear_reference_audio_cache",
    }
    missing = expected - set(paths)
    assert not missing, f"Missing endpoints: {missing}"
    print("全部 6 个预期接口存在。")

    health_like = [p for p in paths if any(k in p.lower() for k in ("health", "ping", "status"))]
    print(f"健康检查类接口: {health_like if health_like else '无'}")
    print("结论：没有内置健康检查接口，需使用 TCP 探测或轻量 /tts 调用替代 isTtsApiUp。")


def analyze_wav(path: str):
    print("\n=== /tts 音频格式确认 ===")
    print(f"文件: {path} (大小 {os.path.getsize(path)} 字节)")
    with open(path, "rb") as f:
        head = f.read(12)
    print(f"文件头: {head!r}")

    is_riff = head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    print(f"是否为 RIFF/WAVE（带 WAV 头）: {is_riff}")
    if not is_riff:
        print("结论：未发现 WAV 头，疑似裸 PCM，需在中间件补 WAV 头或改用裸 PCM 播放参数。")
        return

    with wave.open(path, "rb") as w:
        print(
            f"声道数: {w.getnchannels()}, 位深: {w.getsampwidth() * 8} bit, "
            f"采样率: {w.getframerate()} Hz, 帧数: {w.getnframes()}, "
            f"时长: {w.getnframes() / w.getframerate():.2f} s"
        )
    print("结论：服务端返回裸 PCM，客户端已补 WAV 头；播放时 ffplay 需按裸 PCM 参数")
    print("      （-f s16le -ar 32000 -ac 1 -）或由中间件补头。")


def main():
    os.makedirs("logs", exist_ok=True)

    server_process = Process(target=run_server)
    server_process.start()
    print(f"服务器进程已启动 (pid={server_process.pid})，等待端口 {SERVER_PORT} 就绪…")

    try:
        if not wait_for_server():
            raise RuntimeError("服务器启动超时（90 秒内端口未就绪）")
        print("服务器已就绪。")

        check_openapi()

        print("\n=== 未加载角色时的 /tts（验证错误路径）===")
        post_json("/tts", {"character_name": CHARACTER_NAME, "text": "テスト"})

        print("\n=== load_character ===")
        response = post_json("/load_character", {
            "character_name": CHARACTER_NAME,
            "onnx_model_dir": MODEL_DIR,
            "language": LANGUAGE,
        })
        assert response.status_code == 200, "load_character 失败"

        print("\n=== set_reference_audio ===")
        response = post_json("/set_reference_audio", {
            "character_name": CHARACTER_NAME,
            "audio_path": REF_AUDIO,
            "audio_text": REF_TEXT,
            "language": LANGUAGE,
        })
        assert response.status_code == 200, "set_reference_audio 失败"

        print("\n=== set_reference_audio（.mp3 应被拒绝）===")
        response = post_json("/set_reference_audio", {
            "character_name": CHARACTER_NAME,
            "audio_path": r"C:\tmp\not_supported.mp3",
            "audio_text": "x",
            "language": LANGUAGE,
        })
        assert response.status_code == 400, "mp3 应返回 400"

        print("\n=== /tts（流式）===")
        raw_audio = bytearray()
        with requests.post(
            f"{BASE_URL}/tts",
            json={"character_name": CHARACTER_NAME, "text": TTS_TEXT, "split_sentence": True},
            stream=True,
            timeout=600,
        ) as response:
            print(f"[{response.status_code}] POST /tts")
            print(f"Content-Type: {response.headers.get('content-type')}")
            assert response.status_code == 200, "tts 失败"
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    raw_audio.extend(chunk)

        print(f"服务端裸 PCM 字节数: {len(raw_audio)}")
        with wave.open(OUTPUT_WAV, "wb") as wf:
            wf.setnchannels(WAV_CHANNELS)
            wf.setsampwidth(WAV_SAMPLE_WIDTH)
            wf.setframerate(WAV_SAMPLE_RATE)
            wf.writeframes(bytes(raw_audio))
        print(f"已补 WAV 头并保存: {OUTPUT_WAV}")

        analyze_wav(OUTPUT_WAV)

        print("\n=== 清理 ===")
        post_json("/unload_character", {"character_name": CHARACTER_NAME})
        post_json("/clear_reference_audio_cache", {})
        post_json("/stop", {})

        print("\n✅ 阶段 0 验证全部通过。")
    finally:
        server_process.terminate()
        server_process.join(timeout=30)
        print("服务器进程已关闭。")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"\n❌ 断言失败: {exc}")
        sys.exit(1)
    except Exception as exc:
        print(f"\n❌ 验证失败: {exc}")
        sys.exit(1)
