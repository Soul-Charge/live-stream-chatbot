"""
Genie-TTS 迁移阶段 1：转换产物端到端验证脚本。

对指定角色：
1. 启动 Genie 服务器（GPU 优先，与 phase0_verify.py 相同的 CUDA 配置）。
2. load_character（使用 F:/AiSound/Genie-TTS-onnx/CharacterModels/<角色>/tts_models）。
3. set_reference_audio（使用该角色目录下 prompt_wav.json 中的音频与文本）。
4. /tts 合成一句短日语，补 WAV 头保存到 logs/，断言音频非空且格式正确。

注意：/load_character 即使加载失败也返回 200，因此本脚本以 /tts 实际输出
字节数作为成功判据（加载失败时流为空）。

用法：
    .\.venv-genie\Scripts\python.exe scripts\validate_converted.py --only hiro
"""

import argparse
import json
import os
import socket
import sys
import time
import wave
from multiprocessing import Process

WAV_CHANNELS = 1
WAV_SAMPLE_WIDTH = 2
WAV_SAMPLE_RATE = 32000

SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8000
BASE_URL = f"http://{SERVER_HOST}:{SERVER_PORT}"
MODEL_ROOT = r"F:\AiSound\Genie-TTS-onnx\CharacterModels"
TTS_TEXT = "こんにちは、先生。今日もよろしくお願いします。"
MIN_AUDIO_BYTES = 50000


def _prepare_nvidia_dlls():
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

import requests

import genie_tts as genie


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


def run_server():
    from genie_tts.ModelManager import model_manager

    if cuda_is_usable():
        model_manager.providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        print("[Server] GPU OK: CUDAExecutionProvider")
    else:
        model_manager.providers = ["CPUExecutionProvider"]
        print("[Server] CUDA unavailable, fallback to CPU")
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


def validate_character(name: str) -> bool:
    char_dir = os.path.join(MODEL_ROOT, name)
    model_dir = os.path.join(char_dir, "tts_models")
    prompt_json_path = os.path.join(char_dir, "prompt_wav.json")
    if not all(os.path.exists(p) for p in (model_dir, prompt_json_path)):
        print(f"[{name}] 缺少模型目录或 prompt_wav.json")
        return False

    with open(prompt_json_path, "r", encoding="utf-8") as f:
        prompt = json.load(f)["Normal"]
    ref_audio = os.path.join(char_dir, "prompt_wav", prompt["wav"])
    ref_text = prompt["text"]

    server_process = Process(target=run_server)
    server_process.start()
    try:
        if not wait_for_server():
            print(f"[{name}] 服务器启动超时")
            return False

        response = requests.post(
            f"{BASE_URL}/load_character",
            json={"character_name": name, "onnx_model_dir": model_dir, "language": "jp"},
            timeout=600,
        )
        if response.status_code != 200:
            print(f"[{name}] load_character HTTP {response.status_code}: {response.text}")
            return False

        response = requests.post(
            f"{BASE_URL}/set_reference_audio",
            json={
                "character_name": name,
                "audio_path": ref_audio,
                "audio_text": ref_text,
                "language": "jp",
            },
            timeout=120,
        )
        if response.status_code != 200:
            print(f"[{name}] set_reference_audio HTTP {response.status_code}: {response.text}")
            return False

        raw_audio = bytearray()
        with requests.post(
            f"{BASE_URL}/tts",
            json={"character_name": name, "text": TTS_TEXT, "split_sentence": True},
            stream=True,
            timeout=600,
        ) as response:
            if response.status_code != 200:
                print(f"[{name}] tts HTTP {response.status_code}: {response.text}")
                return False
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    raw_audio.extend(chunk)

        print(f"[{name}] 裸 PCM 字节数: {len(raw_audio)}")
        if len(raw_audio) < MIN_AUDIO_BYTES:
            print(f"[{name}] ❌ 音频过短，疑似模型加载失败（预期 >{MIN_AUDIO_BYTES} 字节）")
            return False

        out_path = os.path.join("logs", f"phase1_{name}.wav")
        with wave.open(out_path, "wb") as wf:
            wf.setnchannels(WAV_CHANNELS)
            wf.setsampwidth(WAV_SAMPLE_WIDTH)
            wf.setframerate(WAV_SAMPLE_RATE)
            wf.writeframes(bytes(raw_audio))
        print(f"[{name}] ✅ 合成成功: {out_path} "
              f"({len(raw_audio) / 2 / WAV_SAMPLE_RATE:.2f}s)")
        return True
    finally:
        try:
            requests.post(f"{BASE_URL}/unload_character", json={"character_name": name}, timeout=30)
            requests.post(f"{BASE_URL}/stop", json={}, timeout=30)
        except Exception:
            pass
        server_process.terminate()
        server_process.join(timeout=30)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", required=True, help="角色目录名")
    args = parser.parse_args()
    os.makedirs("logs", exist_ok=True)
    ok = validate_character(args.only)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
