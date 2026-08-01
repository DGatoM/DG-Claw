import markdown, asyncio, re, base64, os, sys
from playwright.async_api import async_playwright

SRC = '/root/claude/projetos/dgclaw-lite-plugin/APOSTILA.md'
OUT = '/tmp/claude-0/-root-claude-projetos-dg-alive-plugin/9cdf8032-0768-4890-8cc5-735b148dcae7/scratchpad/ziptmp/Apostila-Imersao-Super-Funcionario.pdf'
COVER = '/tmp/claude-0/-root-claude-projetos-dg-alive-plugin/9cdf8032-0768-4890-8cc5-735b148dcae7/scratchpad/capa.jpg'

md = open(SRC, encoding='utf-8').read()

# tira o H1 e o intro (vão pra capa)
parts = md.split('\n---\n', 1)
intro_block, body_md = parts[0], parts[1]
intro_html = markdown.markdown(
    '\n'.join(l for l in intro_block.split('\n') if not l.startswith('# ')),
    extensions=['tables', 'fenced_code'])

html_body = markdown.markdown(body_md, extensions=['tables', 'fenced_code'])

# numera as perguntas (h3) e transforma em cartões
counter = {'n': 0}
def num_q(m):
    counter['n'] += 1
    return f'<h3 class="q"><span class="qn">{counter["n"]}</span>{m.group(1)}</h3>'

# numera SÓ as perguntas da Parte 2 (os h3 da Parte 1 são títulos comuns)
split_at = html_body.find('PARTE 2')
p1, p2 = html_body[:split_at], html_body[split_at:]
html_body = p1 + re.sub(r'<h3>(.*?)</h3>', num_q, p2, flags=re.S)

cover_img = ''
if os.path.exists(COVER):
    ext = 'jpeg' if COVER.lower().endswith(('.jpg', '.jpeg')) else 'png'
    b64 = base64.b64encode(open(COVER, 'rb').read()).decode()
    cover_img = f'<div class="cover-art"><img src="data:image/{ext};base64,{b64}"></div>'

CSS = """
@page { size: A4; margin: 17mm 15mm 20mm; }
@page :first { margin: 0; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
       font-size: 10.4pt; line-height: 1.6; color: #16181d; margin: 0; }

/* ---------- CAPA ---------- */
.cover { height: 297mm; width: 210mm; page-break-after: always; position: relative;
         display: flex; flex-direction: column; background: #fff; overflow: hidden; }
.cover-art { height: 128mm; width: 100%; overflow: hidden; background: #f6f2ef; }
.cover-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-art:empty { display: none; }
.cover-bar { height: 6px; background: #C4643C; width: 100%; }
.cover-text { padding: 20mm 20mm 0; flex: 1; }
.cover-kicker { font-size: 10pt; letter-spacing: .22em; text-transform: uppercase;
                color: #C4643C; font-weight: 700; margin-bottom: 12mm; }
.cover h1 { font-size: 34pt; line-height: 1.12; color: #16181d; font-weight: 800;
            margin: 0 0 8mm; letter-spacing: -0.02em; border: none; padding: 0; }
.cover h1 em { color: #C4643C; font-style: normal; }
.cover .sub { font-size: 12.5pt; color: #4a4f57; line-height: 1.55; max-width: 135mm; }
.cover .foot { padding: 0 20mm 16mm; font-size: 9.5pt; color: #8a9099; }
.cover .foot strong { color: #16181d; }

/* ---------- TÍTULOS ---------- */
h1 { font-size: 19pt; color: #16181d; font-weight: 800; margin: 0 0 14px;
     padding-bottom: 8px; border-bottom: 3px solid #C4643C; page-break-after: avoid;
     letter-spacing: -0.01em; }
h2 { font-size: 13.5pt; color: #16181d; font-weight: 700; margin: 26px 0 12px;
     padding: 7px 0 7px 12px; border-left: 5px solid #C4643C; background: #faf6f3;
     page-break-after: avoid; }
h3 { font-size: 11pt; color: #16181d; margin: 18px 0 6px; page-break-after: avoid; }
h3.q { display: flex; gap: 10px; align-items: flex-start; font-weight: 700;
       margin: 20px 0 7px; page-break-after: avoid; }
.qn { flex: 0 0 auto; min-width: 22px; height: 22px; border-radius: 50%;
      background: #C4643C; color: #fff; font-size: 9pt; font-weight: 700;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0 5px; margin-top: 1px; }
h3.q + p { margin-top: 0; padding-left: 32px; }
h3.q + p + p, h3.q + p + ul, h3.q + p + pre { padding-left: 32px; }

p { margin: 8px 0; orphans: 3; widows: 3; }
li { margin: 3px 0; }
strong { color: #16181d; font-weight: 700; }
em { color: #5b6068; }

code { background: #f3f0ee; color: #a8482a; padding: 1.5px 5px; border-radius: 3px;
       font-family: "SF Mono", Consolas, monospace; font-size: 8.9pt; }
pre { background: #16181d; color: #eceff3; padding: 12px 14px; border-radius: 7px;
      white-space: pre-wrap; word-break: break-word; page-break-inside: avoid;
      margin: 11px 0; border-left: 4px solid #C4643C; }
pre code { background: none; color: inherit; font-size: 8.6pt; padding: 0; }

table { border-collapse: collapse; width: 100%; margin: 13px 0; font-size: 9.4pt;
        page-break-inside: avoid; }
th { background: #16181d; color: #fff; text-align: left; padding: 8px 10px;
     font-weight: 600; }
td { border-bottom: 1px solid #e6e2df; padding: 7px 10px; vertical-align: top; }
tr:nth-child(even) td { background: #faf9f8; }

blockquote { border-left: 4px solid #C4643C; background: #fdf7f4; margin: 13px 0;
             padding: 11px 15px; border-radius: 0 6px 6px 0; page-break-inside: avoid; }
blockquote p { margin: 3px 0; }

hr { border: none; border-top: 1px solid #e6e2df; margin: 26px 0; }
a { color: #a8482a; text-decoration: none; word-break: break-word; }
ol > li::marker { color: #C4643C; font-weight: 700; }
"""

HTML = f"""<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style></head><body>
<div class="cover">
  {cover_img}
  <div class="cover-bar"></div>
  <div class="cover-text">
    <div class="cover-kicker">Imersão Super Funcionário</div>
    <h1>Apostila<br><em>com Claude</em></h1>
    <div class="sub">{intro_html}</div>
  </div>
  <div class="foot"><strong>DG Medeiros</strong> · cpdf.ai</div>
</div>
{html_body}
</body></html>"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page()
        await pg.set_content(HTML, wait_until='load')
        await pg.pdf(path=OUT, format='A4', print_background=True,
                     margin={'top': '17mm', 'bottom': '20mm', 'left': '15mm', 'right': '15mm'})
        await b.close()
    print('PDF:', OUT, '| perguntas numeradas:', counter['n'], '| capa:', bool(cover_img))

asyncio.run(main())
