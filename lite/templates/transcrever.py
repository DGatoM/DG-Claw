#!/usr/bin/env python3
# Transcreve um audio, 100% nesta maquina. Uso: python transcrever.py <audio>
import json, os, sys
from faster_whisper import WhisperModel

cfg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio.json")
try:
    modelo = json.load(open(cfg, encoding="utf-8")).get("modelo_local") or "small"
except Exception:
    modelo = "small"
try:                                  # usa a placa NVIDIA, se houver
    m = WhisperModel(modelo, device="cuda", compute_type="float16")
except Exception:                     # senao, CPU mesmo
    m = WhisperModel(modelo, device="cpu", compute_type="int8")
segs, _ = m.transcribe(sys.argv[1], language="pt", vad_filter=True)
print(" ".join(s.text.strip() for s in segs).strip())
