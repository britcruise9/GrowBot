#!/usr/bin/env python3
# Generates vercel-app/cutout-template.html
# Minimal cut template: a scale-check box, the base plate, and the two legs. Nothing else.
# Authored entirely in mm (SVG viewBox user-unit = 1mm) so it prints at true 1:1.

OUT = "/Users/brit/Desktop/phone-body/vercel-app/cutout-template.html"

W, H = 180.0, 214.0
L = 8.0

el = []
def add(s): el.append(s)
def rect(x,y,w,h,cls="cut",rx=0):
    add(f'<rect x="{x:.3f}" y="{y:.3f}" width="{w:.3f}" height="{h:.3f}" rx="{rx}" class="{cls}"/>')
def text(x,y,s,cls="lbl",anchor="middle"):
    add(f'<text x="{x:.3f}" y="{y:.3f}" text-anchor="{anchor}" class="{cls}">{s}</text>')

# ===== calibration box (scale check) =====
sx,sy,ss = L, 10.0, 50.0
rect(sx,sy,ss,ss,"check")
text(sx+ss/2, sy+ss/2-3.5, "CHECK", "check-hd")
text(sx+ss/2, sy+ss/2+3.0, "50 mm", "check-hd")
text(sx+ss/2, sy+ss/2+8.5, "2 in", "tiny")
# short verify note beside the box
nx = sx+ss+9
text(nx, sy+14, "Print at 100% (actual size).", "note", "start")
text(nx, sy+20, "Each side of this square must", "note", "start")
text(nx, sy+25.5, "measure 50 mm (2 in).", "note", "start")
text(nx, sy+33, "If it is smaller, your printer", "note", "start")
text(nx, sy+38.5, "shrank the page. Reprint with", "note", "start")
text(nx, sy+44, "Fit to Page turned off.", "note", "start")

# ===== base plate =====
# Flat stand-in for the printed body shell (170 x 68.6 x 14.5 mm). Same footprint,
# so the phone, board and battery land where the build photos show them.
px,py,pw,ph = L, 76.0, 170.0, 68.6
rect(px,py,pw,ph,"cut",rx=2)
text(px+pw/2, py+ph/2-2.5, "BASE PLATE   (cut 1)", "shape-hd")
text(px+pw/2, py+ph/2+4.5, "170 x 68.6 mm   /   6 11/16 x 2 11/16 in", "shape-sub")

# ===== legs =====
lw,lh = 84.0, 21.0
text(L, 156.0, "LEGS   (cut two the same)", "shape-hd2", "start")
for ly0 in (160.0, 184.0):
    rect(L, ly0, lw, lh, "cut", rx=3)
    text(L+lw/2, ly0+lh/2+1.2, "LEG   84 x 21 mm   /   3 5/16 x 13/16 in", "shape-sub")

svg = "\n".join(el)

HTML = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GrowBot body template (print at 100%)</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  html, body {{ margin:0; padding:0; background:#eef1f4; color:#0b0e13;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }}

  .screen {{ max-width: 720px; margin: 0 auto; padding: 22px 18px 6px; }}
  .screen h1 {{ font-size: 21px; margin:0 0 6px; }}
  .screen p  {{ font-size: 15px; line-height:1.5; margin:8px 0; color:#26303d; }}
  .btn {{ display:inline-block; margin:8px 0 2px; padding:12px 20px; border:0; border-radius:10px;
    background:#147a4b; color:#fff; font-size:16px; font-weight:700; cursor:pointer; }}
  .btn:hover {{ background:#0f6740; }}
  .fine {{ color:#5a6675; font-size:13px; }}

  .sheetwrap {{ display:flex; justify-content:center; padding: 10px 10px 40px; }}
  .sheet {{ background:#fff; box-shadow:0 2px 14px rgba(0,0,0,.12); }}
  svg.tmpl {{ display:block; }}

  /* everything is a stroke on transparent fill so it prints regardless of the
     "Background graphics" setting, and reads the same in black and white. */
  svg.tmpl text {{ fill:#000; font-family: ui-sans-serif, system-ui, Arial, sans-serif; }}
  .cut   {{ fill:none; stroke:#000; stroke-width:0.5; }}
  .check {{ fill:none; stroke:#000; stroke-width:0.6; }}
  .check-hd {{ font-size:5px; font-weight:800; }}
  .tiny  {{ font-size:3px; }}
  .note  {{ font-size:3.1px; }}
  .shape-hd  {{ font-size:5px; font-weight:800; }}
  .shape-hd2 {{ font-size:4.2px; font-weight:800; }}
  .shape-sub {{ font-size:3.2px; }}

  @media print {{
    @page {{ size: auto; margin: 8mm; }}
    html, body {{ background:#fff; }}
    .screen {{ display:none !important; }}
    .sheetwrap {{ padding:0; display:block; }}
    .sheet {{ box-shadow:none; }}
  }}
</style>
</head>
<body>

  <div class="screen">
    <h1>GrowBot body template</h1>
    <p>No 3D printer? Print this at full size and cut the base plate and the two legs out of any stiff flat material (about 4.5 mm thick).</p>
    <button class="btn" onclick="window.print()">Print this page</button>
    <p class="fine">Print at 100%, actual size, with Fit to Page off. Then check the square measures 50 mm before you cut. Screens are not to scale, only the printed page is.</p>
  </div>

  <div class="sheetwrap">
    <div class="sheet">
      <svg class="tmpl" xmlns="http://www.w3.org/2000/svg"
           width="{W:.0f}mm" height="{H:.0f}mm" viewBox="0 0 {W:.0f} {H:.0f}">
{svg}
      </svg>
    </div>
  </div>

</body>
</html>
"""

with open(OUT,"w") as f:
    f.write(HTML)
print("wrote", OUT, len(HTML), "bytes  | canvas", W, "x", H, "mm")
