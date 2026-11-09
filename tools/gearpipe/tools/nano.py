"""Minimal Nano Banana (Gemini image) client. Key comes from $GOOGLE_API."""
import base64, io, json, os, sys, urllib.request
from PIL import Image

MODEL = os.environ.get("NANO_MODEL", "gemini-2.5-flash-image")
URL = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"


def _png_part(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(buf.getvalue()).decode()}}


def generate(prompt, images=(), aspect="2:3", model=MODEL):
    parts = [_png_part(i) for i in images] + [{"text": prompt}]
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": aspect}},
    }
    req = urllib.request.Request(
        URL.format(model), data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GOOGLE_API"]},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.load(r)
    for cand in data.get("candidates", []):
        for p in cand.get("content", {}).get("parts", []):
            blob = p.get("inline_data") or p.get("inlineData")
            if blob:
                return Image.open(io.BytesIO(base64.b64decode(blob["data"]))).convert("RGBA")
    raise RuntimeError("no image returned: " + json.dumps(data)[:800])


if __name__ == "__main__":
    out, prompt = sys.argv[1], sys.argv[2]
    refs = [Image.open(p).convert("RGBA") for p in sys.argv[3:]]
    generate(prompt, refs).save(out)
    print("saved", out)
