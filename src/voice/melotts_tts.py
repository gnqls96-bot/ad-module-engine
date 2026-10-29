"""MeloTTS 한국어 음성 생성 (ad-module-engine에서 호출).

설치:
  pip install git+https://github.com/myshell-ai/MeloTTS.git
  python -m unidic download
"""
import argparse

from melo.api import TTS

p = argparse.ArgumentParser()
p.add_argument("--text", required=True)
p.add_argument("--out", required=True)
p.add_argument("--speaker", default="KR")
p.add_argument("--speed", type=float, default=1.0)
a = p.parse_args()

model = TTS(language="KR", device="auto")
speakers = model.hps.data.spk2id
speaker_id = speakers[a.speaker] if a.speaker in speakers else list(speakers.values())[0]
model.tts_to_file(a.text, speaker_id, a.out, speed=a.speed, quiet=True)
