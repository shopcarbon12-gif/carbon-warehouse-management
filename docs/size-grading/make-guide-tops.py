"""Guide pictures for tops (public/size-grading/guide/tee.webp, longsleeve.webp).
Numbered in pomsFor("top","front") order: 1 chest, 2 length, 3 shoulder, 4 sleeve,
5 hem; colours = POM_COLOR in size-grading-workspace.tsx. Run, then convert:
  python3 docs/size-grading/make-guide-tops.py && node -e "..." (see below)."""
COL={'chest':'#facc15','length':'#3b82f6','shoulder':'#22c55e','sleeve':'#8b5cf6','hem':'#f43f5e'}
def arrow(x1,y1,x2,y2,c,n,lx,ly):
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{c}" stroke-width="7" marker-start="url(#m{n})" marker-end="url(#m{n})"/>'
            f'<circle cx="{lx}" cy="{ly}" r="30" fill="{c}" stroke="#0b0d12" stroke-width="5"/>'
            f'<text x="{lx}" y="{ly+12}" text-anchor="middle" font-size="34" font-weight="800" fill="#0b0d12" font-family="Arial">{n}</text>')
def page(body_path, lines, extra=''):
    defs=''.join(f'<marker id="m{n}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="{c}"/></marker>' for n,c in [(1,COL['chest']),(2,COL['length']),(3,COL['shoulder']),(4,COL['sleeve']),(5,COL['hem'])])
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 1100" width="1100" height="1100"><defs>{defs}</defs><rect width="1100" height="1100" fill="#0b0d12"/><path d="{body_path}" fill="#d9dde4" stroke="#9aa3b2" stroke-width="3" stroke-linejoin="round"/>{extra}{lines}</svg>'
# short-sleeve tee (coordinates ×1.7 of the sketch, shifted)
def T(x,y): return round(x*1.7+40,1), round(y*1.55+60,1)
pts=[(240,60),(360,60),(450,90),(540,230),(490,262),(430,200),(425,600),(175,600),(170,200),(110,262),(60,230),(150,90)]
P=[T(*p) for p in pts]
neck=f'M{P[0][0]},{P[0][1]} Q{T(300,125)[0]},{T(300,125)[1]} {P[1][0]},{P[1][1]}'
tee='M'+' L'.join(f'{x},{y}' for x,y in [P[0]])+f' Q{T(300,125)[0]},{T(300,125)[1]} {P[1][0]},{P[1][1]} L'+' L'.join(f'{x},{y}' for x,y in P[2:])+' Z'
seams=f'<path d="M{T(152,93)[0]},{T(152,93)[1]} L{T(172,200)[0]},{T(172,200)[1]} M{T(448,93)[0]},{T(448,93)[1]} L{T(428,200)[0]},{T(428,200)[1]}" stroke="#7d8696" stroke-width="2.5" stroke-dasharray="9 7" fill="none"/>'
L=''
a,b=T(172,225),T(428,225); L+=arrow(a[0],a[1],b[0],b[1],COL['chest'],1,(a[0]+b[0])/2,a[1])
a,b=T(255,62),T(255,598); L+=arrow(a[0],a[1],b[0],b[1],COL['length'],2,a[0],T(0,380)[1])
a,b=T(150,80),T(450,80); L+=arrow(a[0],a[1],b[0],b[1],COL['shoulder'],3,T(400,0)[0],a[1])
a,b=T(144,84),T(54,224); L+=arrow(a[0],a[1],b[0],b[1],COL['sleeve'],4,T(80,140)[0],T(80,140)[1])
a,b=T(176,614),T(424,614); L+=arrow(a[0],a[1],b[0],b[1],COL['hem'],5,(a[0]+b[0])/2,a[1])
open('/tmp/claude-1000/-home-carbondev-dev-carbon-warehouse-management/49ccf484-ed34-40f9-8c3e-3c621d48251f/scratchpad/tee.svg','w').write(page(tee,L,seams))
# long sleeve: sleeves run down to the wrists
lpts=[(240,60),(360,60),(450,90),(530,420),(480,440),(430,210),(425,600),(175,600),(170,210),(120,440),(70,420),(150,90)]
LP=[T(*p) for p in lpts]
ls='M'+f'{LP[0][0]},{LP[0][1]}'+f' Q{T(300,125)[0]},{T(300,125)[1]} {LP[1][0]},{LP[1][1]} L'+' L'.join(f'{x},{y}' for x,y in LP[2:])+' Z'
L2=''
a,b=T(172,235),T(428,235); L2+=arrow(a[0],a[1],b[0],b[1],COL['chest'],1,(a[0]+b[0])/2,a[1])
a,b=T(255,62),T(255,598); L2+=arrow(a[0],a[1],b[0],b[1],COL['length'],2,a[0],T(0,380)[1])
a,b=T(150,80),T(450,80); L2+=arrow(a[0],a[1],b[0],b[1],COL['shoulder'],3,T(400,0)[0],a[1])
a,b=T(140,92),T(62,418); L2+=arrow(a[0],a[1],b[0],b[1],COL['sleeve'],4,T(84,260)[0],T(84,260)[1])
a,b=T(176,614),T(424,614); L2+=arrow(a[0],a[1],b[0],b[1],COL['hem'],5,(a[0]+b[0])/2,a[1])
open('/tmp/claude-1000/-home-carbondev-dev-carbon-warehouse-management/49ccf484-ed34-40f9-8c3e-3c621d48251f/scratchpad/longsleeve.svg','w').write(page(ls,L2,seams))
