#!/usr/bin/env python3
"""Local server for the Map Editor's Gear view (offline paper-doll asset authoring).

It does two jobs from one process:
  1. Serves the repo statically (so http://localhost:8765/editor/ and /client/ load),
     the same job tools/serve.js does for play-testing.
  2. Exposes a tiny gear API that drives the bundled art pipeline in tools/gearpipe/
     (Nano Banana generate -> pixelize to a 32x48 layer -> tint mask), the same pipeline
     the owner runs by hand with `make_gear.py`.

    GOOGLE_API=<your Gemini key> python3 tools/gear_server.py [port]

Then open http://localhost:8765/editor/ and switch to the Gear view.

Requirements: Python 3 with Pillow and numpy (same as the pipeline). The Gemini key can be
given in the environment (preferred -- it never touches the browser) or typed into the view.

This is a LOCAL dev tool only: it writes files into the repo and runs arbitrary image
generation. Do not expose it to a network.
"""
import base64
import json
import os
import re
import shutil
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # repo root
PIPE = os.path.join(ROOT, "tools", "gearpipe")
PIPE_TOOLS = os.path.join(PIPE, "tools")
ART_OUT = os.path.join(ROOT, "art", "sprites", "paperdoll")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

TYPES = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".ico": "image/x-icon", ".webp": "image/webp",
}

NAME_RE = re.compile(r"^[a-z0-9_]+$")
_lock = threading.Lock()   # the pipeline uses shared dirs + env; serialise generations
_mg = None                 # the imported make_gear module (loaded lazily)


def load_pipeline():
    """Import the vendored pipeline once and make sure its scratch dirs exist."""
    global _mg
    if _mg is None:
        if PIPE_TOOLS not in sys.path:
            sys.path.insert(0, PIPE_TOOLS)
        import make_gear                      # noqa: E402  (vendored, tools/gearpipe/tools)
        os.makedirs(make_gear.bg.RAW, exist_ok=True)
        os.makedirs(make_gear.bg.OUT, exist_ok=True)
        _mg = make_gear
    return _mg


def b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def file_prefix(mg, slot, kind):
    """The on-disk filename prefix the pipeline uses for this slot (weapons keep sword_/gun_)."""
    if slot == "weapon":
        return mg.WEAPON_PREFIX.get(kind or "blade", "sword")
    return mg.SLOTS[slot][0]


def gear_make(req):
    mg = load_pipeline()
    slot = (req.get("slot") or "").strip()
    name = (req.get("name") or "").strip()
    what = (req.get("what") or "").strip()
    tint = (req.get("tint") or "").strip() or None
    kind = (req.get("kind") or "").strip() or None
    keep_hair = bool(req.get("keep_hair"))
    try:
        variants = max(1, min(3, int(req.get("variants") or 1)))
    except (TypeError, ValueError):
        variants = 1

    if slot not in mg.SLOTS:
        return {"error": "Unknown slot: " + slot}
    if not NAME_RE.match(name):
        return {"error": "Name must be snake_case (lowercase letters, numbers, underscores)."}
    if not what:
        return {"error": "Describe what the item looks like."}

    key = (req.get("google_api") or os.environ.get("GOOGLE_API") or "").strip()
    if not key:
        return {"error": "no_key"}
    os.environ["GOOGLE_API"] = key

    names = [name] if variants == 1 else ["%s_v%d" % (name, i + 1) for i in range(variants)]
    import numpy as np                         # noqa: E402 (available once pipeline imports)
    from PIL import Image                       # noqa: E402

    out_variants = []
    with _lock:                                 # one generation at a time (shared scratch dirs)
        for n in names:
            mg.make(slot, n, what, tint, keep_hair, kind)
            prefix = file_prefix(mg, slot, kind)
            fname = "%s_%s" % (prefix, n)
            layer = os.path.join(mg.bg.OUT, fname + ".png")
            mask = layer[:-4] + ".tint.png"
            sheet = os.path.join(mg.bg.OUT, "review_" + fname + ".png")
            has_mask = os.path.exists(mask)
            solid = int((np.asarray(Image.open(layer))[..., 3] > 0).sum())
            out_variants.append({
                "name": n,
                "fname": fname,
                "prefix": prefix,
                "slot": slot,
                "layer": b64(layer),
                "tint": b64(mask) if has_mask else None,
                "review": b64(sheet),
                "solid_px": solid,
                "has_mask": has_mask,
                # hides_hair only means anything for helm items; None = not applicable
                "hides_hair": (False if keep_hair else True if slot == "helm" else None),
            })
    return {"variants": out_variants}


def gear_save(req):
    mg = load_pipeline()
    fname = (req.get("fname") or "").strip()
    if not fname or not NAME_RE.match(fname.replace(".", "_")):
        return {"error": "Bad file name."}
    src = os.path.join(mg.bg.OUT, fname + ".png")
    if not os.path.exists(src):
        return {"error": "Nothing generated for " + fname + " yet."}
    os.makedirs(ART_OUT, exist_ok=True)
    written = []
    shutil.copy2(src, os.path.join(ART_OUT, fname + ".png"))
    written.append("art/sprites/paperdoll/" + fname + ".png")
    mask = src[:-4] + ".tint.png"
    if os.path.exists(mask):
        shutil.copy2(mask, os.path.join(ART_OUT, fname + ".tint.png"))
        written.append("art/sprites/paperdoll/" + fname + ".tint.png")
    return {"saved": written}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):          # keep the console quiet
        if self.path.startswith("/gear/"):
            sys.stderr.write("gear %s %s\n" % (self.command, self.path))

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = unquote(self.path.split("?")[0])
        if path == "/gear/ping":
            return self._json({"ok": True, "has_key": bool(os.environ.get("GOOGLE_API"))})
        if path.endswith("/"):
            path += "index.html"
        fp = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not (fp == ROOT or fp.startswith(ROOT + os.sep)):
            return self.send_error(403, "forbidden")
        if not os.path.isfile(fp):
            return self.send_error(404, "not found")
        with open(fp, "rb") as f:
            data = f.read()
        ctype = TYPES.get(os.path.splitext(fp)[1].lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            req = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return self._json({"error": "bad json"}, 400)
        try:
            if path == "/gear/make":
                res = gear_make(req)
            elif path == "/gear/save":
                res = gear_save(req)
            else:
                return self.send_error(404, "not found")
        except Exception as e:                  # noqa: BLE001 -- report any pipeline failure to the view
            traceback.print_exc()
            res = {"error": str(e)[:400] or e.__class__.__name__}
        self._json(res)


def main():
    if not os.path.isdir(PIPE_TOOLS):
        sys.exit("Missing vendored pipeline at " + PIPE_TOOLS)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("Gear maker + static server on http://localhost:%d" % PORT)
    print("  Editor:  http://localhost:%d/editor/   (switch to the Gear view)" % PORT)
    print("  Key:     GOOGLE_API is %s" % ("set" if os.environ.get("GOOGLE_API") else "NOT set (type it in the view, or set it and restart)"))
    print("  Stop with Ctrl+C")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
