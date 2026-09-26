"""Pinned export from production SVGs; immutable docs references are never modified."""
import argparse, base64, hashlib, io, json, math, pathlib
import xml.etree.ElementTree as ET
import cairosvg
from PIL import Image, __version__ as pillow_version
ROOT = pathlib.Path(__file__).resolve().parent.parent
BRAND = ROOT / "public/brand"
parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
parser.add_argument("--emit", action="store_true")
args = parser.parse_args()
if cairosvg.__version__ != "2.8.2" or pillow_version != "12.3.0":
    raise SystemExit("Use pinned CairoSVG 2.8.2 and Pillow 12.3.0.")
sources = {}
allowed = {"svg", "title", "defs", "linearGradient", "stop", "path", "g"}
for name in ["a-mark-primary.svg", "a-mark-small.svg", "a-mark-mono.svg", "a-app-master.svg", "a-app-maskable.svg"]:
    data = (BRAND / name).read_bytes()
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise SystemExit("External XML declarations are forbidden.")
    for node in ET.fromstring(data).iter():
        if node.tag.split("}")[-1] not in allowed:
            raise SystemExit("Unsupported SVG element.")
        for key, value in node.attrib.items():
            if key.lower().split("}")[-1].startswith("on") or "href" in key.lower() or "style" in key.lower():
                raise SystemExit("SVG scripts, hrefs and CSS dependencies are forbidden.")
            if "url(" in value and not value.startswith("url(#"):
                raise SystemExit("External SVG resources are forbidden.")
    sources[name] = data
# Conservative bounds of all source paths after the maskable transform.
for x in (16, 238):
    for y in (16, 236):
        if math.hypot(215 + 2.32*x - 512, 215 + 2.32*y - 512) > 409.6:
            raise SystemExit("Maskable mark exceeds the safe circle.")
outputs = {"public/brand/favicon.svg": sources["a-mark-small.svg"]}
specs = [
    ("favicon-16.png", "a-mark-small.svg", 16, False),
    ("favicon-24.png", "a-mark-small.svg", 24, False),
    ("favicon-32.png", "a-mark-small.svg", 32, False),
    ("favicon-48.png", "a-mark-small.svg", 48, False),
    ("apple-touch-icon.png", "a-app-master.svg", 180, True),
    ("icon-192.png", "a-app-master.svg", 192, True),
    ("icon-512.png", "a-app-master.svg", 512, True),
    ("icon-maskable-512.png", "a-app-maskable.svg", 512, True),
    ("app-icon-1024.png", "a-app-master.svg", 1024, True),
]
images = {}
for name, source, size, opaque in specs:
    rendered = cairosvg.svg2png(bytestring=sources[source], output_width=size, output_height=size)
    image = Image.open(io.BytesIO(rendered)).convert("RGBA")
    if opaque and image.getchannel("A").getextrema() != (255, 255):
        raise SystemExit("Installation icons must be fully opaque.")
    stream = io.BytesIO()
    image.save(stream, format="PNG", optimize=True, compress_level=9)
    outputs["public/brand/" + name] = stream.getvalue()
    images[size, source] = image
stream = io.BytesIO()
images[48, "a-mark-small.svg"].save(stream, format="ICO", sizes=[(16,16), (32,32), (48,48)],
    append_images=[images[16, "a-mark-small.svg"], images[32, "a-mark-small.svg"]])
outputs["public/brand/favicon.ico"] = stream.getvalue()
outputs["public/favicon.ico"] = stream.getvalue()
assets = {("public/brand/" + n): data for n, data in sources.items()}
assets.update(outputs)
manifest = {
    "schema": "todayaction-brand-assets-v1",
    "direction": "approved-A-three-part",
    "reference_sha256": "3916158ffd7f8a21d52715024afb2ff8b95b4d1e78cfd0a58def6bb4a0ea8114",
    "tools": {"cairosvg": "2.8.2", "pillow": "12.3.0"},
    "assets": {p: {"sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for p,b in sorted(assets.items())},
}
outputs["public/brand/ASSET_MANIFEST.json"] = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode()
different = []
for path, data in outputs.items():
    existing = ROOT / path
    if not existing.exists() or existing.read_bytes() != data:
        different.append(path)
        if args.emit:
            print("TA_ASSET:" + json.dumps({"path": path, "base64": base64.b64encode(data).decode(),
                "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}))
    if not args.check:
        existing.parent.mkdir(parents=True, exist_ok=True)
        existing.write_bytes(data)
print("TA_ASSET_RESULT:" + json.dumps({"different": different, "check": args.check, "outputs": len(outputs)}))
if args.check and different:
    raise SystemExit("Committed assets differ from the pinned exporter; inspect emitted candidates.")
