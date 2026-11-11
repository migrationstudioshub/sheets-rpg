#!/usr/bin/env python3
"""Local server for the Map Editor's offline art makers (Gear, Tileset, Objects).

It does two jobs from one process:
  1. Serves the repo statically (so http://localhost:8765/studio/, /editor/ and /client/ load),
     the same job tools/serve.js does for play-testing.
  2. Exposes tiny APIs that drive the bundled art pipelines, the same ones the owner runs by hand:
       /gear/*    -> tools/gearpipe   (make_gear.py: bust layer + tint mask) [in-process import]
       /tile/*    -> tools/tilepipe   (make_tileset.py: ground autotile + variety, or wall) [subprocess]
       /object/*  -> tools/objpipe    (make_objects.py: footprint map object, facings) [subprocess]
     Approved files are copied into art/sprites/paperdoll/, art/tilesets/ or art/sprites/objects/.

    GOOGLE_API=<your Gemini key> python3 tools/asset_server.py [port]

Then open http://localhost:8765/studio/ for the art makers (Gear / Tileset / Objects). The map
editor at /editor/ is maps only. (tools/gear_server.py still works as a shim for this file.)

Requirements: Python 3 with Pillow and numpy (same as the pipeline). The Gemini key can be
given in the environment (preferred -- it never touches the browser) or typed into the view.

This is a LOCAL dev tool only: it writes files into the repo and runs arbitrary image
generation. Do not expose it to a network.
"""
import base64
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # repo root
PIPE = os.path.join(ROOT, "tools", "gearpipe")
PIPE_TOOLS = os.path.join(PIPE, "tools")
ART_OUT = os.path.join(ROOT, "art", "sprites", "paperdoll")

# Tileset + map-object makers reuse the same server. Their pipelines live beside gearpipe but
# share module names (palette/pixelize/nano...), so they run as isolated subprocesses, not imports.
TILE_TOOLS = os.path.join(ROOT, "tools", "tilepipe", "tools")
TILE_OUT = os.path.join(ROOT, "tools", "tilepipe", "out", "tiles")
OBJ_TOOLS = os.path.join(ROOT, "tools", "objpipe", "tools")
OBJ_OUT = os.path.join(ROOT, "tools", "objpipe", "out", "objects")
ART_TILES = os.path.join(ROOT, "art", "tilesets")
ART_OBJ = os.path.join(ROOT, "art", "sprites", "objects")
KEY_FILE = os.path.join(ROOT, "tools", "google_api_key.txt")   # git-ignored; local only
KEY_TEMPLATE = (
    "# Paste your Google Gemini API key on the line below (just the key, nothing else), then\n"
    "# save and close this file. It stays on your machine and is git-ignored.\n"
    "# Get a key at https://aistudio.google.com/apikey\n\n"
)
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


def read_key():
    """The Gemini key, from GOOGLE_API if set, else the first real line of the key file."""
    env = (os.environ.get("GOOGLE_API") or "").strip()
    if env:
        return env
    try:
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s and not s.startswith("#"):
                    return s
    except OSError:
        pass
    return ""


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

    key = read_key() or (req.get("google_api") or "").strip()
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
    fname = (req.get("fname") or "").strip()            # the generated source in out/gear
    dest = (req.get("dest_fname") or fname).strip()     # what to call it in art/ (may rename)
    confirm = bool(req.get("confirm"))                  # overwrite an existing file on purpose
    if not fname or not NAME_RE.match(fname):
        return {"error": "Bad source name."}
    if not NAME_RE.match(dest):
        return {"error": "Save-as name must be snake_case (lowercase letters, numbers, underscores)."}
    src = os.path.join(mg.bg.OUT, fname + ".png")
    if not os.path.exists(src):
        return {"error": "Nothing generated for " + fname + " yet."}
    dest_png = os.path.join(ART_OUT, dest + ".png")
    if os.path.exists(dest_png) and not confirm:
        return {"needs_confirm": True, "dest": dest}    # don't clobber silently
    os.makedirs(ART_OUT, exist_ok=True)
    written = []
    shutil.copy2(src, dest_png)
    written.append("art/sprites/paperdoll/" + dest + ".png")
    mask = src[:-4] + ".tint.png"
    if os.path.exists(mask):
        shutil.copy2(mask, os.path.join(ART_OUT, dest + ".tint.png"))
        written.append("art/sprites/paperdoll/" + dest + ".tint.png")
    return {"saved": written}


def gear_open_key_file(req):
    """Create the local key file if missing and open it in the OS default editor."""
    if not os.path.exists(KEY_FILE):
        with open(KEY_FILE, "w", encoding="utf-8") as f:
            f.write(KEY_TEMPLATE)
    opened = True
    try:
        if sys.platform.startswith("win"):
            os.startfile(KEY_FILE)   # type: ignore[attr-defined]  # noqa: S606 (local dev tool)
        elif sys.platform == "darwin":
            import subprocess
            subprocess.Popen(["open", KEY_FILE])
        else:
            import subprocess
            subprocess.Popen(["xdg-open", KEY_FILE])
    except Exception:                 # noqa: BLE001 -- report the path so the user can open it by hand
        opened = False
    return {"path": "tools/google_api_key.txt", "opened": opened}


def run_pipe(tools_dir, script, argv):
    """Run a vendored pipeline CLI as an isolated subprocess (its own sys.path / module set)."""
    cmd = [sys.executable, os.path.join(tools_dir, script)] + argv
    p = subprocess.run(cmd, cwd=tools_dir, env=dict(os.environ),
                       capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "pipeline failed").strip()[-400:])
    return p.stdout


def _img(path):
    """{file, b64, w, h} for an existing PNG, else None."""
    if not os.path.exists(path):
        return None
    from PIL import Image
    im = Image.open(path)
    return {"file": os.path.basename(path), "b64": b64(path), "w": im.width, "h": im.height}


def tile_suggest(kind, name):
    """Copyable Tilesets + Terrain rows for the owner's sheet (or data/tables.json)."""
    if kind == "wall":
        return ("Tilesets  id=%s  image=art/tilesets/%s_top_auto.png  columns=8  layout=blob47_craftpix\n"
                "Terrain   id=%s  autotile=%s  color=#2b2b2b  pass_n/e/s/w = 0 (walls block)\n"
                "Face auto-renders from art/tilesets/%s_face.png (filename convention)."
                % (name, name, name, name, name))
    return ("Tilesets  id=%s  image=art/tilesets/%s_auto.png  columns=8  layout=blob47_craftpix\n"
            "Terrain   id=%s  autotile=%s  color=<avg>  pass_n/e/s/w = 1\n"
            "Variety layer + base tile auto-render from art/tilesets/%s{_details,_decals,}.png + scatter.json."
            % (name, name, name, name, name))


def tile_make(req):
    kind = (req.get("kind") or "ground").strip()
    name = (req.get("name") or "").strip()
    if kind not in ("ground", "wall"):
        return {"error": "kind must be ground or wall"}
    if not NAME_RE.match(name):
        return {"error": "Name must be snake_case (lowercase letters, numbers, underscores)."}
    key = read_key() or (req.get("google_api") or "").strip()
    if kind == "ground" and not key:
        return {"error": "no_key"}                  # walls are procedural, no Gemini needed
    if key:
        os.environ["GOOGLE_API"] = key
    os.makedirs(TILE_OUT, exist_ok=True)

    # The review patch for both kinds is drawn on an "under" terrain; seed its sheet into the
    # scratch dir (we ship asphalt) so the review doesn't fail looking for a base that isn't there.
    under = (req.get("under") or "asphalt").strip()
    if not (NAME_RE.match(under) and under != name
            and os.path.exists(os.path.join(ART_TILES, under + "_auto.png"))):
        under = name
    elif not os.path.exists(os.path.join(TILE_OUT, under + "_auto.png")):
        shutil.copy2(os.path.join(ART_TILES, under + "_auto.png"),
                     os.path.join(TILE_OUT, under + "_auto.png"))

    with _lock:                                      # shared scratch dir: one at a time
        if kind == "ground":
            what = (req.get("what") or "").strip()
            if not what:
                return {"error": "Describe the ground surface."}
            argv = ["ground", "--name", name, "--what", what, "--under", under]
            if req.get("pattern"):                   # built surfaces: keep seams/welds, small units
                argv += ["--pattern"]
            decals = (req.get("decals") or "").strip()
            if decals:
                argv += ["--decals", decals]
            run_pipe(TILE_TOOLS, "make_tileset.py", argv)
            want = {"base": name + ".png", "auto": name + "_auto.png",
                    "details": name + "_details.png", "decals": name + "_decals.png",
                    "review": "review_" + name + ".png"}
        else:
            material = (req.get("material") or "brick").strip()
            if not re.match(r"^[a-z_]+$", material):
                return {"error": "Bad material."}
            run_pipe(TILE_TOOLS, "make_tileset.py",
                     ["wall", "--name", name, "--material", material, "--under", under])
            want = {"top": name + "_top_auto.png", "face": name + "_face.png",
                    "review": "review_" + name + ".png"}

    images = {}
    for k, fn in want.items():
        got = _img(os.path.join(TILE_OUT, fn))
        if got:
            images[k] = got
    scatter = {}
    sj = os.path.join(TILE_OUT, "scatter.json")
    if os.path.exists(sj):
        try:
            scatter = json.load(open(sj)).get(name, {})
        except ValueError:
            pass
    return {"kind": kind, "name": name, "images": images, "scatter": scatter,
            "suggest": tile_suggest(kind, name)}


def tile_save(req):
    name = (req.get("name") or "").strip()
    kind = (req.get("kind") or "ground").strip()
    confirm = bool(req.get("confirm"))
    if not NAME_RE.match(name):
        return {"error": "Bad name."}
    suffixes = (("_top_auto.png", "_face.png") if kind == "wall"
                else (".png", "_auto.png", "_details.png", "_decals.png"))
    present = [name + s for s in suffixes if os.path.exists(os.path.join(TILE_OUT, name + s))]
    if not present:
        return {"error": "Nothing generated for " + name + " yet."}
    clash = [n for n in present if os.path.exists(os.path.join(ART_TILES, n))]
    if clash and not confirm:
        return {"needs_confirm": True, "dest": name}
    os.makedirs(ART_TILES, exist_ok=True)
    written = []
    for n in present:
        shutil.copy2(os.path.join(TILE_OUT, n), os.path.join(ART_TILES, n))
        written.append("art/tilesets/" + n)
    if kind == "ground":                             # merge this terrain into the live scatter config
        src = os.path.join(TILE_OUT, "scatter.json")
        dst = os.path.join(ART_TILES, "scatter.json")
        if os.path.exists(src):
            cfg = {}
            if os.path.exists(dst):
                try:
                    cfg = json.load(open(dst))
                except ValueError:
                    cfg = {}
            try:
                entry = json.load(open(src)).get(name)
                if entry:
                    cfg[name] = entry
            except ValueError:
                pass
            json.dump(cfg, open(dst, "w"), indent=1)
            written.append("art/tilesets/scatter.json")
    return {"saved": written}


def object_suggest(name, tiles_w):
    return ("Objects      id=%s  name=%s  kind=deco  sprite=art/sprites/objects/%s.png  walkable=FALSE\n"
            "             properties={\"width\": %d}   (add \"layer\":\"ground_decal\" or \"wall\" if needed;\n"
            "             for facings set sprite_states=\"down=...; up=...; side=...\" and MapEntities data {\"facing\":\"down\"})\n"
            "MapEntities  map=<id>  key=<id>  ref=%s  x=<cx>  y=<cy>   (footprint = the object's bottom row)"
            % (name, name.replace("_", " "), name, tiles_w, name))


def object_make(req):
    name = (req.get("name") or "").strip()
    what = (req.get("what") or "").strip()
    size = (req.get("size") or "").strip()
    if not NAME_RE.match(name):
        return {"error": "Name must be snake_case (lowercase letters, numbers, underscores)."}
    if not what:
        return {"error": "Describe the object."}
    if not re.match(r"^\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*$", size):
        return {"error": "Size must be W,H,D in metres, e.g. 1.0,1.9,0.4"}
    key = read_key() or (req.get("google_api") or "").strip()
    if not key:
        return {"error": "no_key"}
    os.environ["GOOGLE_API"] = key
    try:
        variants = max(1, min(3, int(req.get("variants") or 1)))
    except (TypeError, ValueError):
        variants = 1
    views = (req.get("views") or "down").strip()
    if not re.match(r"^(down|up|side)(,(down|up|side))*$", views):
        return {"error": "views must be a comma list of down,up,side"}
    argv = ["--name", name, "--what", what, "--size", size.replace(" ", ""),
            "--variants", str(variants), "--views", views]
    box = (req.get("box") or "").strip()
    if box:
        if not re.match(r"^\d+x\d+$", box):
            return {"error": "box must be WxH in pixels, e.g. 26x40"}
        argv += ["--box", box]
    if req.get("free_top"):
        argv += ["--free-top"]
    os.makedirs(OBJ_OUT, exist_ok=True)
    with _lock:
        run_pipe(OBJ_TOOLS, "make_objects.py", argv)

    produced = sorted(os.path.basename(p) for p in glob.glob(os.path.join(OBJ_OUT, name + "*.png"))
                      if not os.path.basename(p).startswith("review_"))
    variants_out = []
    for fn in produced:
        got = _img(os.path.join(OBJ_OUT, fn))
        if got:
            got["name"] = fn[:-4]
            got["tiles_w"] = max(1, round(got["w"] / 32))
            variants_out.append(got)
    tiles_w = variants_out[0]["tiles_w"] if variants_out else 1
    return {"name": name, "variants": variants_out,
            "review": _img(os.path.join(OBJ_OUT, "review_" + name + ".png")),
            "suggest": object_suggest(name, tiles_w)}


def object_save(req):
    fname = (req.get("fname") or "").strip()
    dest = (req.get("dest_fname") or fname).strip()
    confirm = bool(req.get("confirm"))
    if not NAME_RE.match(fname):
        return {"error": "Bad source name."}
    if not NAME_RE.match(dest):
        return {"error": "Save-as name must be snake_case (lowercase letters, numbers, underscores)."}
    src = os.path.join(OBJ_OUT, fname + ".png")
    if not os.path.exists(src):
        return {"error": "Nothing generated for " + fname + " yet."}
    dst = os.path.join(ART_OBJ, dest + ".png")
    if os.path.exists(dst) and not confirm:
        return {"needs_confirm": True, "dest": dest}
    os.makedirs(ART_OBJ, exist_ok=True)
    shutil.copy2(src, dst)
    return {"saved": ["art/sprites/objects/" + dest + ".png"]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):          # keep the console quiet
        if self.path.startswith(("/gear/", "/tile/", "/object/")):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

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
            return self._json({"ok": True, "has_key": bool(read_key())})
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
            elif path == "/gear/open-key-file":
                res = gear_open_key_file(req)
            elif path == "/tile/make":
                res = tile_make(req)
            elif path == "/tile/save":
                res = tile_save(req)
            elif path == "/object/make":
                res = object_make(req)
            elif path == "/object/save":
                res = object_save(req)
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
    print("Asset Studio + static server on http://localhost:%d" % PORT)
    print("  Studio:  http://localhost:%d/studio/   (Gear / Tileset / Objects makers)" % PORT)
    print("  Editor:  http://localhost:%d/editor/   (maps only)" % PORT)
    print("  Key:     Gemini key is %s" % ("set" if read_key() else "NOT set (use the view's 'API key' button, or set GOOGLE_API)"))
    print("  Stop with Ctrl+C")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
