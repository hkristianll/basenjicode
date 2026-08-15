#!/usr/bin/env python3
"""
NordCode voice sidecar — local speech-to-text + text-to-speech.

A tiny localhost HTTP service, in the same spirit as LM Studio (:1234) and
ComfyUI (:8188): NordCode talks to it over 127.0.0.1, nothing leaves the machine.

  STT: faster-whisper (CTranslate2) — runs on the GPU when CUDA is available.
  TTS: Kokoro (kokoro-onnx) — an 82M neural voice, British male by default.

Endpoints
  GET  /health          -> {"status":"ok", ...capabilities...}
  POST /stt   (wav bytes)            -> {"text": "..."}
  POST /tts   ({"text","voice"})     -> audio/wav bytes

Both models are loaded lazily and warmed in the background at startup, so the
first real request isn't paying the load cost. Model inference is serialized
behind a lock (the models aren't guaranteed thread-safe), while the HTTP layer
stays threaded so /health and overlapping STT/TTS never deadlock.

Config via env:
  NORDCODE_VOICE_HOST     (default 127.0.0.1)
  NORDCODE_VOICE_PORT     (default 8123)
  NORDCODE_STT_MODEL      (default small.en)   any faster-whisper model id
  NORDCODE_STT_DEVICE     (default auto)       auto | cuda | cpu
  NORDCODE_TTS_VOICE      (default bm_george)  any Kokoro voice id
  NORDCODE_TTS_LANG       (default en-gb)
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import queue
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

WAKE_MODEL = os.environ.get("NORDCODE_WAKE_MODEL", "hey_jarvis")
WAKE_THRESHOLD = float(os.environ.get("NORDCODE_WAKE_THRESHOLD", "0.5"))

HOST = os.environ.get("NORDCODE_VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("NORDCODE_VOICE_PORT", "8123"))
STT_MODEL = os.environ.get("NORDCODE_STT_MODEL", "distil-large-v3")
STT_DEVICE_PREF = os.environ.get("NORDCODE_STT_DEVICE", "auto")
TTS_VOICE = os.environ.get("NORDCODE_TTS_VOICE", "bm_george")
TTS_LANG = os.environ.get("NORDCODE_TTS_LANG", "en-gb")

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, "models")
KOKORO_ONNX = os.path.join(MODELS_DIR, "kokoro-v1.0.onnx")
KOKORO_VOICES = os.path.join(MODELS_DIR, "voices-v1.0.bin")
KOKORO_ONNX_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
KOKORO_VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
# SHA-256 of the official model-files-v1.0 release artifacts (the .onnx hash is confirmed against upstream).
# A re-download whose bytes don't match these is rejected — fail closed on a tampered/corrupt model rather
# than loading whatever a hijacked URL served.
KOKORO_ONNX_SHA256 = "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"
KOKORO_VOICES_SHA256 = "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"

# Hard ceiling on any request body. Without it, a single request advertising a huge Content-Length makes
# _read_body allocate gigabytes (memory-exhaustion DoS). A WAV command clip or a TTS JSON is well under this.
MAX_BODY_BYTES = 25 * 1024 * 1024

# Hosts that are safe to bind without authentication. Anything else exposes this UNAUTHENTICATED service
# (which can switch on the microphone and drive the speakers) to other machines.
LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")


def log(*a: object) -> None:
    print("[voice]", *a, flush=True)


def _add_cuda_dll_dirs() -> None:
    """faster-whisper's CTranslate2 backend needs CUDA 12 cuBLAS/cuDNN DLLs at *inference* time,
    but doesn't put the pip-installed `nvidia-*-cu12` bin folders on the DLL search path. Add them
    so the GPU path works; harmless no-op when those packages aren't installed (we fall back to CPU)."""
    if os.name != "nt":
        return
    import site

    roots = list(site.getsitepackages())
    user_site = site.getusersitepackages()
    if user_site:
        roots.append(user_site)
    found: list[str] = []
    for sp in roots:
        nv = os.path.join(sp, "nvidia")
        if not os.path.isdir(nv):
            continue
        for sub in os.listdir(nv):
            for leaf in ("bin", os.path.join("lib", "bin")):
                b = os.path.join(nv, sub, leaf)
                if os.path.isdir(b) and b not in found:
                    found.append(b)
    for b in found:
        try:
            os.add_dll_directory(b)
        except OSError:
            pass
    # CTranslate2's native loader doesn't always honor add_dll_directory; prepending PATH is the
    # more compatible route so cublas64_12.dll (and its cudart/cudnn deps) resolve at inference.
    if found:
        os.environ["PATH"] = os.pathsep.join(found) + os.pathsep + os.environ.get("PATH", "")


# --------------------------------------------------------------------------- #
# Speech-to-text (faster-whisper)
# --------------------------------------------------------------------------- #
class STT:
    def __init__(self) -> None:
        self._model = None
        self._lock = threading.Lock()
        self.device = "cpu"
        self.compute = "int8"
        self.error: str | None = None
        self._fell_back = False

    def _pick_device(self) -> None:
        if STT_DEVICE_PREF in ("cuda", "cpu"):
            self.device = STT_DEVICE_PREF
        else:
            try:
                import ctranslate2

                self.device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
            except Exception:
                self.device = "cpu"
        self.compute = "float16" if self.device == "cuda" else "int8"

    def _build(self):
        from faster_whisper import WhisperModel

        log(f"loading STT model {STT_MODEL} on {self.device} ({self.compute}) …")
        t0 = time.time()
        m = WhisperModel(STT_MODEL, device=self.device, compute_type=self.compute)
        log(f"STT ready in {time.time() - t0:.1f}s")
        return m

    def load(self) -> None:
        if self._model is not None or self.error is not None:
            return
        with self._lock:
            if self._model is not None or self.error is not None:
                return
            try:
                self._pick_device()
                if self.device == "cuda":
                    _add_cuda_dll_dirs()
                    try:
                        self._model = self._build()
                        return
                    except Exception as e:  # noqa: BLE001
                        # GPU full (OOM) or CUDA libs missing — fall back to CPU at load so STT still
                        # works when both GPUs are busy (LM Studio + ComfyUI eat the VRAM).
                        log("CUDA load failed, falling back to CPU:", e)
                        self._fell_back = True
                        self.device, self.compute = "cpu", "int8"
                self._model = self._build()
            except Exception as e:  # noqa: BLE001
                self.error = f"{type(e).__name__}: {e}"
                log("STT load failed:", self.error)

    def _run(self, wav: bytes) -> str:
        # vad_filter trims leading/trailing silence so a half-second of room tone
        # doesn't get hallucinated into "you" / "thank you" the way bare Whisper does.
        segments, _info = self._model.transcribe(io.BytesIO(wav), language="en", vad_filter=True, beam_size=1)
        return "".join(seg.text for seg in segments).strip()

    @staticmethod
    def _is_cuda_lib_error(e: Exception) -> bool:
        s = f"{type(e).__name__} {e}".lower()
        return any(k in s for k in ("cublas", "cudnn", "cuda", "library", "cannot be loaded", "no kernel image"))

    def transcribe(self, wav: bytes) -> str:
        self.load()
        if self._model is None:
            raise RuntimeError(self.error or "STT unavailable")
        with self._lock:
            try:
                return self._run(wav)
            except Exception as e:  # noqa: BLE001
                # CTranslate2 loads the model on the GPU fine but only needs cuBLAS/cuDNN at the first
                # matmul — so a missing-CUDA-DLL error surfaces here, not at load. Drop to CPU once and
                # retry so transcription always works. Only on a genuine CUDA/library error, though —
                # a bad-audio InvalidDataError must propagate, not silently demote us to CPU forever.
                if self.device == "cuda" and not self._fell_back and self._is_cuda_lib_error(e):
                    log("CUDA inference failed, falling back to CPU:", e)
                    self._fell_back = True
                    self.device, self.compute = "cpu", "int8"
                    self._model = self._build()
                    return self._run(wav)
                raise


# --------------------------------------------------------------------------- #
# Text-to-speech (Kokoro)
# --------------------------------------------------------------------------- #
class TTS:
    def __init__(self) -> None:
        self._kokoro = None
        self._lock = threading.Lock()
        self.error: str | None = None
        self.sample_rate = 24000

    @staticmethod
    def _download(url: str, dest: str, sha256: str) -> None:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = dest + ".part"
        log(f"downloading {os.path.basename(dest)} …")
        h = hashlib.sha256()
        with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:  # noqa: S310
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                h.update(chunk)
                f.write(chunk)
        digest = h.hexdigest()
        if digest != sha256:
            # Hash mismatch ⇒ the URL served something other than the pinned release. Don't promote the .part
            # into place; refuse to use it. (HTTPS authenticates the host, not the bytes — a hijacked release
            # asset or a MITM with a rogue cert would otherwise be loaded and run as a model.)
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise RuntimeError(
                f"{os.path.basename(dest)} SHA-256 mismatch: expected {sha256}, got {digest} — refusing a tampered/corrupt model"
            )
        os.replace(tmp, dest)
        log(f"  -> {os.path.basename(dest)} ({os.path.getsize(dest) // (1 << 20)} MB, sha256 ok)")

    def load(self) -> None:
        if self._kokoro is not None or self.error is not None:
            return
        with self._lock:
            if self._kokoro is not None or self.error is not None:
                return
            try:
                from kokoro_onnx import Kokoro

                if not os.path.exists(KOKORO_ONNX):
                    self._download(KOKORO_ONNX_URL, KOKORO_ONNX, KOKORO_ONNX_SHA256)
                if not os.path.exists(KOKORO_VOICES):
                    self._download(KOKORO_VOICES_URL, KOKORO_VOICES, KOKORO_VOICES_SHA256)
                log("loading TTS (Kokoro) …")
                t0 = time.time()
                self._kokoro = Kokoro(KOKORO_ONNX, KOKORO_VOICES)
                log(f"TTS ready in {time.time() - t0:.1f}s")
            except Exception as e:  # noqa: BLE001
                self.error = f"{type(e).__name__}: {e}"
                log("TTS load failed:", self.error)

    def synth(self, text: str, voice: str) -> bytes:
        self.load()
        if self._kokoro is None:
            raise RuntimeError(self.error or "TTS unavailable")
        with self._lock:
            samples, sr = self._kokoro.create(text, voice=voice or TTS_VOICE, speed=1.0, lang=TTS_LANG)
        return pcm_to_wav(samples, sr)


def pcm_to_wav(samples, sample_rate: int) -> bytes:
    """Encode a float32 [-1,1] numpy array as a little-endian 16-bit mono WAV (stdlib only)."""
    import struct
    import numpy as np

    arr = np.asarray(samples, dtype=np.float32)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype("<i2").tobytes()
    data_len = len(pcm)
    header = b"RIFF" + struct.pack("<I", 36 + data_len) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", data_len)
    return header + pcm


STT_ENGINE = STT()
TTS_ENGINE = TTS()


def int16_to_wav(pcm: "np.ndarray", sample_rate: int = 16000) -> bytes:
    return pcm_to_wav(pcm.astype(np.float32) / 32768.0, sample_rate)


# --------------------------------------------------------------------------- #
# Wake word ("Hey Jarvis") — continuous mic, openWakeWord, then record + STT.
# Pushes events to subscribers over Server-Sent Events (/events).
# --------------------------------------------------------------------------- #
class WakeListener:
    SR = 16000
    FRAME = 1280  # 80 ms @ 16 kHz — openWakeWord's expected chunk

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._running = False
        self._subs: list[queue.Queue] = []
        self._subs_lock = threading.Lock()
        self._idle_timer: threading.Timer | None = None
        self.error: str | None = None
        self.active = False

    # ---- SSE subscriber registry ----
    def add_subscriber(self, q: queue.Queue) -> None:
        with self._subs_lock:
            self._subs.append(q)
            if self._idle_timer:
                self._idle_timer.cancel()
                self._idle_timer = None

    def remove_subscriber(self, q: queue.Queue) -> None:
        with self._subs_lock:
            if q in self._subs:
                self._subs.remove(q)
            # No one is listening for wake events (app closed / all tabs gone) → release the mic after a
            # short grace so a transient SSE reconnect doesn't churn it. Restarted on the next /wake/start.
            if not self._subs and self._running and not self._idle_timer:
                self._idle_timer = threading.Timer(10.0, self._idle_stop)
                self._idle_timer.daemon = True
                self._idle_timer.start()

    def _idle_stop(self) -> None:
        with self._subs_lock:
            self._idle_timer = None
            if self._subs:
                return
        log("no event subscribers for 10s — stopping wake listener, mic released")
        self.stop()

    def _emit(self, event: dict) -> None:
        with self._subs_lock:
            subs = list(self._subs)
        for q in subs:
            q.put(event)

    # ---- lifecycle ----
    def start(self) -> dict:
        if self._running:
            return {"ok": True, "active": True}
        self.error = None
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return {"ok": True, "active": True}

    def stop(self) -> dict:
        self._running = False
        self.active = False
        return {"ok": True, "active": False}

    def _run(self) -> None:
        try:
            import sounddevice as sd
            import openwakeword
            from openwakeword.model import Model

            openwakeword.utils.download_models([WAKE_MODEL])
            model = Model(wakeword_models=[WAKE_MODEL], inference_framework="onnx")
            log(f"wake listener up — say 'Hey Jarvis' (threshold {WAKE_THRESHOLD})")
            self.active = True
            cooldown_until = 0.0
            with sd.InputStream(samplerate=self.SR, channels=1, dtype="int16", blocksize=self.FRAME) as stream:
                while self._running:
                    frame, _ = stream.read(self.FRAME)
                    audio = frame[:, 0]
                    scores = model.predict(audio)
                    score = scores.get(WAKE_MODEL, 0.0)
                    if score >= WAKE_THRESHOLD and time.monotonic() >= cooldown_until:
                        self._emit({"type": "wake"})
                        model.reset()
                        cmd = self._record_command(stream)
                        if cmd.size < self.SR // 4:  # < 0.25 s → nothing said
                            self._emit({"type": "idle"})
                        else:
                            self._emit({"type": "transcribing"})
                            try:
                                text = STT_ENGINE.transcribe(int16_to_wav(cmd))
                            except Exception as e:  # noqa: BLE001
                                self._emit({"type": "error", "detail": str(e)})
                                text = ""
                            self._emit({"type": "command", "text": text})
                        cooldown_until = time.monotonic() + 1.5
        except Exception as e:  # noqa: BLE001
            self.error = f"{type(e).__name__}: {e}"
            log("wake listener failed:", self.error)
            self._emit({"type": "error", "detail": self.error})
        finally:
            self.active = False
            self._running = False

    def _record_command(self, stream, max_s: float = 8.0, hang_s: float = 0.8, lead_s: float = 2.0):
        """After the wake word, record the command until ~hang_s of trailing silence (or max_s).
        faster-whisper's own VAD trims the edges, so a coarse RMS endpointer is plenty."""
        dt = self.FRAME / self.SR
        thresh = 450.0  # int16 RMS; speech is a few thousand, room tone a few hundred
        frames = []
        voiced = False
        silence = 0.0
        lead = 0.0
        elapsed = 0.0
        self._emit({"type": "listening"})
        while elapsed < max_s and self._running:
            frame, _ = stream.read(self.FRAME)
            a = frame[:, 0]
            frames.append(a.copy())
            rms = float(np.sqrt(np.mean(a.astype(np.float32) ** 2)))
            elapsed += dt
            if rms > thresh:
                voiced = True
                silence = 0.0
            elif voiced:
                silence += dt
                if silence >= hang_s:
                    break
            else:
                lead += dt
                if lead >= lead_s:  # nothing spoken shortly after the wake word
                    break
        return np.concatenate(frames) if frames else np.zeros(0, dtype=np.int16)


WAKE = WakeListener()


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class BodyTooLarge(Exception):
    """Raised by _read_body when a request advertises a body larger than MAX_BODY_BYTES."""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a) -> None:  # silence default per-request stderr spam
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # No Access-Control-Allow-Origin: this is a loopback-only service for NordCode's main process, not a
        # browser API. Without ACAO no web page can READ a response, and the Origin guard below blocks the
        # side-effecting requests (mic on, TTS) a "simple" cross-origin POST could otherwise trigger.
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json")

    def _sse_headers(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def _sse_write(self, payload: str) -> None:
        data = payload.encode("utf-8")
        self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def _events(self) -> None:
        q: queue.Queue = queue.Queue()
        WAKE.add_subscriber(q)
        try:
            self._sse_headers()
            self._sse_write(": connected\n\n")
            while True:
                try:
                    ev = q.get(timeout=15)
                except queue.Empty:
                    self._sse_write(": ping\n\n")  # heartbeat keeps the socket alive + detects disconnect
                    continue
                self._sse_write(f"data: {json.dumps(ev)}\n\n")
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client went away
        finally:
            WAKE.remove_subscriber(q)

    def _read_body(self) -> bytes:
        try:
            n = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            n = 0
        if n < 0 or n > MAX_BODY_BYTES:
            # Don't allocate/read an over-large (or unparsable) body. Close the connection so an unread body
            # can't desync the next request on this keep-alive socket.
            self.close_connection = True
            raise BodyTooLarge(n)
        return self.rfile.read(n) if n > 0 else b""

    def _cross_origin(self) -> bool:
        # NordCode's main-process client sends NO Origin header (Node fetch, like the ticket-board client). A
        # browser tab / other web page ALWAYS sends one on a POST (and on a cross-origin GET) — so an Origin
        # header means the request did not come from NordCode. Reject it: this is an unauthenticated local
        # service that can switch on the microphone (/wake/start) and drive the speakers (/tts), so a silent
        # cross-origin "simple" POST from a malicious page must not reach a handler.
        return self.headers.get("Origin") is not None

    def do_GET(self) -> None:
        if self._cross_origin():
            self._json(403, {"error": "cross-origin requests are not allowed"})
            return
        path = self.path.rstrip("/")
        if path in ("/health", "/healthz", ""):
            self._json(
                200,
                {
                    "status": "ok",
                    "service": "nordcode-voice",
                    "stt": {"model": STT_MODEL, "device": STT_ENGINE.device, "error": STT_ENGINE.error},
                    "tts": {"voice": TTS_VOICE, "lang": TTS_LANG, "error": TTS_ENGINE.error},
                    "wake": {"model": WAKE_MODEL, "active": WAKE.active, "error": WAKE.error},
                },
            )
            return
        if path == "/events":
            self._events()
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self._cross_origin():
            self._json(403, {"error": "cross-origin requests are not allowed"})
            return
        try:
            if self.path.rstrip("/") == "/stt":
                wav = self._read_body()
                if not wav:
                    self._json(400, {"error": "empty audio"})
                    return
                text = STT_ENGINE.transcribe(wav)
                self._json(200, {"text": text})
                return
            if self.path.rstrip("/") == "/tts":
                payload = json.loads(self._read_body() or b"{}")
                text = (payload.get("text") or "").strip()
                if not text:
                    self._json(400, {"error": "empty text"})
                    return
                wav = TTS_ENGINE.synth(text, payload.get("voice") or TTS_VOICE)
                self._send(200, wav, "audio/wav")
                return
            if self.path.rstrip("/") == "/wake/start":
                self._read_body()
                self._json(200, WAKE.start())
                return
            if self.path.rstrip("/") == "/wake/stop":
                self._read_body()
                self._json(200, WAKE.stop())
                return
            self._json(404, {"error": "not found"})
        except BodyTooLarge as e:
            self._json(413, {"error": f"request body too large (> {MAX_BODY_BYTES} bytes): Content-Length {e}"})
        except Exception as e:  # noqa: BLE001
            self._json(503, {"error": f"{type(e).__name__}: {e}"})


def _warm() -> None:
    # Warm sequentially, not in two parallel threads: on Python 3.14 the heavy first-imports of
    # faster-whisper and kokoro-onnx racing in separate threads trips a "partially initialized
    # module 'typing'" circular-import error. One at a time sidesteps it entirely.
    STT_ENGINE.load()
    TTS_ENGINE.load()


class QuietHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        # A client (NordCode) closing an SSE stream mid-write raises ConnectionReset/BrokenPipe —
        # expected churn, not a fault. Swallow those; let anything genuinely unexpected through.
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def main() -> None:
    if HOST not in LOOPBACK_HOSTS:
        log(
            f"WARNING: binding to non-loopback host {HOST!r}. This service is UNAUTHENTICATED and can switch on "
            f"the microphone and drive the speakers — exposing it beyond 127.0.0.1 lets other machines on the "
            f"network do so. Set NORDCODE_VOICE_HOST=127.0.0.1 unless you intentionally want LAN exposure."
        )
    # Warm both models in the background so the first real request is snappy.
    threading.Thread(target=_warm, daemon=True).start()
    server = QuietHTTPServer((HOST, PORT), Handler)
    log(f"NordCode voice sidecar listening on http://{HOST}:{PORT}")
    log(f"  STT={STT_MODEL}  TTS voice={TTS_VOICE} ({TTS_LANG})  wake='{WAKE_MODEL}'")
    log("  hands-free starts on demand via POST /wake/start")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
