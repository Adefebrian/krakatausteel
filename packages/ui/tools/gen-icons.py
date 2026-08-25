import json, re, subprocess, sys, os, urllib.request

OUT = "/Users/brianeedsleep/Documents/krakatausteel/packages/ui/src/icon-data.ts"
VER = "1.2.0"

# local name -> reicon-react icon name (reicon.dev, MIT, Outline weight)
MAP = {
    "dashboard": "Layout",
    "pumk": "Banknote",
    "nonpumk": "HandHeart",
    "jurnal": "BookOpen",
    "laporan": "ChartBar",
    "admin": "ShieldCheck",
    "konfigurasi": "Gear",
    "portal": "Globe",
    "tools": "Import",
    "search": "Search",
    "filter": "Filter",
    "menu": "Menu",
    "close": "X",
    "check": "Check",
    "chevronDown": "AngleDown",
    "chevronRight": "AngleRight",
    "chevronUp": "AngleUp",
    "logout": "Logout",
    "user": "User2",
    "building": "Building",
    "calendar": "Calendar",
    "alert": "AlertTriangle2",
    "info": "InfoCircle",
    "lock": "Lock",
    "list": "List3",
    "refresh": "Refresh",
    "plus": "Plus",
    "download": "Download2",
    "eye": "Eye",
    "eyeOff": "EyeOff",
    # Fase 3 (spec 9.1) additions: the PUMK screens need a back affordance, a
    # photo/document upload, a cluster (people) mark, a receipt, a calculator,
    # a history mark and a cash-account mark. Same source and same weight.
    "arrowLeft": "ArrowLeft",
    "arrowRight": "ArrowRight",
    "upload": "Upload",
    "users": "Users",
    "file": "FileText",
    "trash": "Trash",
    "calculator": "Calculator",
    "phone": "Phone",
    "camera": "Camera",
    "handshake": "Handshake",
    "wallet": "Wallet",
    "receipt": "Receipt",
    "checkCircle": "CheckCircle",
    "minus": "Minus",
    "history": "History",
    "bank": "Bank",
}

def fetch(name):
    url = f"https://cdn.jsdelivr.net/npm/reicon-react@{VER}/icons/{name}.js"
    try:
        return urllib.request.urlopen(url, timeout=30).read().decode()
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"fetch failed {name}: {exc}")

paths = {}
problems = []
for local, rname in MAP.items():
    src = fetch(rname)
    m = re.search(r"O:\s*`(.*?)`", src, re.S)
    if not m:
        problems.append(f"{rname}: no Outline variant")
        continue
    inner = m.group(1).strip()
    tags = re.findall(r"<(\w+)", inner)
    if set(tags) != {"path"}:
        problems.append(f"{rname}: non-path children {sorted(set(tags))}")
        continue
    ds = re.findall(r'<path[^>]*\sd="([^"]+)"', inner)
    strokes = re.findall(r'<path[^>]*\sstroke="([^"]+)"', inner)
    if strokes:
        problems.append(f"{rname}: stroke-based path, needs manual handling")
        continue
    if not ds:
        problems.append(f"{rname}: no d attribute")
        continue
    paths[local] = ds

if problems:
    print("PROBLEMS:\n" + "\n".join(problems), file=sys.stderr)

header = """// GENERATED FILE, do not hand edit.
//
// Source: reicon.dev (https://reicon.dev), reicon-react@%s, "Outline" weight,
// MIT licensed. Regenerate with tools/gen-icons.py.
//
// The koboyo icon MCP is the first source per jal-frontend-rules; reicon.dev
// is the documented fallback and was used here because the koboyo MCP was not
// reachable from the build environment. Every glyph below is filled with
// currentColor and drawn on a 24x24 viewBox, so one Icon wrapper controls
// size and color for the whole product.

export const ICON_VIEWBOX = "0 0 24 24";

export const ICON_PATHS = {
""" % VER

lines = []
for local, ds in paths.items():
    joined = ",\n".join('    "%s"' % d for d in ds)
    lines.append('  %s: [\n%s,\n  ],' % (local, joined))

body = "\n".join(lines)
footer = """
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICON_PATHS;
"""

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    f.write(header + body + footer)

print("wrote", OUT, len(paths), "icons,", os.path.getsize(OUT), "bytes")
print("names:", " ".join(sorted(paths)))
for k,v in sorted(paths.items(), key=lambda kv: -sum(len(d) for d in kv[1])):
    print("  ", k, sum(len(d) for d in v))
