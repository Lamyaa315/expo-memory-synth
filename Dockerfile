# Laqya on Render (or any Docker host): the Python server (scripts/server.py) serving web/ and Saad's API.
# The Gemini key is an environment variable set on the host (GEMINI_API_KEY), never in the repo.
# Voice cloning (scripts/voice_clone.py) needs a GPU machine and stays off here; everything else runs.
FROM python:3.11-slim

# edge-tts: Saad's backup voice when Gemini's daily voice quota runs out
RUN pip install --no-cache-dir edge-tts

WORKDIR /app
COPY scripts/server.py scripts/gemini_client.py scripts/tts.py scripts/fetch_scene.py scripts/
COPY web/ web/

# The scene is in Git LFS: if the host checked out pointers instead of the files, fetch them from GitHub
ARG REPO=Lamyaa315/expo-memory-synth
ARG REF=main
RUN python scripts/fetch_scene.py "$REPO" "$REF"

ENV HOST=0.0.0.0 PYTHONUNBUFFERED=1
# Render sets PORT; 8000 elsewhere
CMD ["python", "scripts/server.py"]
