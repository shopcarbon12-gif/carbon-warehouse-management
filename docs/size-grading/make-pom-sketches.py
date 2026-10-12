import math
C=['#e6194b','#f58231','#d4a000','#3cb44b','#0aa5a5','#4363d8','#911eb4','#f032e6','#808000','#9a6324','#008080','#e6005c','#5a5aff','#2f8f2f','#c71585','#ff6f00']
def arrow(x1,y1,x2,y2,col,label,lx=None,ly=None,dash=False):
    d=f' stroke-dasharray="6 4"' if dash else ''
    s=f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{col}" stroke-width="4" marker-start="url(#a{col[1:]})" marker-end="url(#a{col[1:]})"{d}/>'
    if lx is None: lx,ly=(x1+x2)/2,(y1+y2)/2
    s+=f'<circle cx="{lx}" cy="{ly}" r="15" fill="{col}" stroke="#fff" stroke-width="2.5"/><text x="{lx}" y="{ly+6}" text-anchor="middle" font-size="17" font-weight="800" fill="#fff" font-family="Arial">{label}</text>'
    return s
def markers():
    return '<defs>'+''.join(f'<marker id="a{c[1:]}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4.2" markerHeight="4.2" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="{c}"/></marker>' for c in C)+'</defs>'
def svg(w,h,body): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{markers()}{body}</svg>'
FAB='fill="#eef1f5" stroke="#2b3240" stroke-width="2.5" stroke-linejoin="round"'
SEAM='fill="none" stroke="#2b3240" stroke-width="1.2" stroke-dasharray="4 3"'
def lab(x,y,t): return f'<text x="{x}" y="{y}" text-anchor="middle" font-size="20" font-weight="700" fill="#2b3240" font-family="Arial">{t}</text>'
# ---------- T-SHIRT ----------
tee='M240,60 Q300,{n} 360,60 L450,90 L540,230 L490,262 L430,200 L425,600 L175,600 L170,200 L110,262 L60,230 L150,90 Z'
def tee_front():
    b=f'<path d="{tee.format(n=130)}" {FAB}/>'
    b+=f'<path d="M248,63 Q300,144 352,63" {SEAM}/>'+f'<path d="M152,93 L172,200 M448,93 L428,200 M70,224 L116,253 M530,224 L484,253 M177,588 L423,588" {SEAM}/>'
    k=0;L=[]
    def A(*a,**kw):
        nonlocal b,k; b+=arrow(*a[:4],C[k],chr(65+k),*a[4:],**kw); k+=1
    A(172,225,428,225,300,225)          # A chest
    A(173,400,427,400,330,400)          # B waist
    A(176,612,424,612,300,612)          # C hem
    A(255,62,255,598,255,330)           # D length HPS
    A(150,82,450,82,410,82)             # E shoulder
    A(452,96,432,198,466,150)           # F armhole
    A(144,84,54,224,82,140)             # G sleeve length
    A(170,206,110,268,128,250)          # H underarm sleeve
    A(430,200,494,159,476,192)          # I bicep
    A(546,232,494,266,532,264)          # J sleeve opening
    A(242,48,358,48,300,30)             # K neck width
    A(300,60,300,96,330,108)            # L front neck drop
    b+=f'<line x1="240" y1="60" x2="360" y2="60" stroke="{C[11]}" stroke-width="1.5" stroke-dasharray="3 3"/>'
    A(300,98,300,106,272,124)           # M rib height  (letter M)
    b+=f'<line x1="300" y1="102" x2="281" y2="117" stroke="{C[12]}" stroke-width="2"/>'
    b+=f'<line x1="360" y1="60" x2="470" y2="60" stroke="{C[13]}" stroke-width="1.5" stroke-dasharray="3 3"/>'
    A(470,62,470,88,492,62)             # N shoulder slope
    return svg(600,650,b+lab(300,645,'FRONT')),k
def tee_back(k0):
    b=f'<path d="{tee.format(n=84)}" {FAB}/>'+f'<path d="M248,62 Q300,94 352,62" {SEAM}/><path d="M177,588 L423,588" {SEAM}/>'
    b+=f'<line x1="240" y1="60" x2="360" y2="60" stroke="{C[k0]}" stroke-width="1.5" stroke-dasharray="3 3"/>'
    b+=arrow(300,60,300,72,C[k0],chr(65+k0),330,44)
    b+=arrow(300,74,300,598,C[k0+1],chr(66+k0),300,330)
    return svg(600,650,b+lab(300,645,'BACK'))
# ---------- PANTS ----------
P='M150,40 L450,40 L460,220 L435,720 L315,720 L300,290 L285,720 L165,720 L140,220 Z'
def pants_front():
    b=f'<path d="{P}" {FAB}/><path d="M151,75 L452,75 M300,75 Q300,240 300,250 M300,250 Q310,262 300,288 M200,75 Q195,140 146,152 M400,75 Q405,140 454,152 M168,706 L283,706 M317,706 L432,706" {SEAM}/>'
    for x in (190,250,350,410): b+=f'<rect x="{x-5}" y="36" width="10" height="44" fill="none" stroke="#2b3240" stroke-width="1.5"/>'
    k=0
    def A(*a,**kw):
        nonlocal b,k; b+=arrow(*a[:4],C[k],chr(65+k),*a[4:],**kw); k+=1
    A(151,57,449,57,240,57)       # A waist
    A(142,232,458,232,380,232)    # B hip
    A(146,312,298,312,200,312)    # C thigh
    A(155,505,292,505,210,505)    # D knee
    A(160,612,288,612,215,612)    # E calf
    A(166,734,284,734,225,734)    # F leg opening
    A(306,296,321,716,330,560)    # G inseam
    b+=f'<polyline points="472,40 470,40 470,220 445,720" fill="none" stroke="{C[7]}" stroke-width="4" marker-start="url(#a{C[7][1:]})" marker-end="url(#a{C[7][1:]})"/>'
    b+=f'<circle cx="462" cy="470" r="15" fill="{C[7]}" stroke="#fff" stroke-width="2.5"/><text x="462" y="476" text-anchor="middle" font-size="17" font-weight="800" fill="#fff" font-family="Arial">H</text>'; k+=1
    A(292,42,292,288,268,160)     # I front rise
    A(425,42,425,73,425,98)       # J waistband height
    A(202,79,148,150,160,108)     # K front pocket
    return svg(600,770,b+lab(300,765,'FRONT')),k
def pants_back(k0):
    b=f'<path d="{P}" {FAB}/><path d="M151,75 L452,75 M150,98 Q300,130 452,98 M300,130 L300,288 M168,706 L283,706 M317,706 L432,706" {SEAM}/>'
    for x in (190,250,350,410): b+=f'<rect x="{x-5}" y="36" width="10" height="44" fill="none" stroke="#2b3240" stroke-width="1.5"/>'
    for x0 in (178,328): b+=f'<path d="M{x0},132 L{x0+94},132 L{x0+90},215 L{x0+47},232 L{x0+4},215 Z" fill="none" stroke="#2b3240" stroke-width="2"/>'
    b+=arrow(308,42,308,288,C[k0],chr(65+k0),332,200)
    b+=arrow(180,124,270,124,C[k0+1],chr(66+k0),225,106)
    b+=arrow(225,134,225,230,C[k0+2],chr(67+k0),200,190)
    return svg(600,770,b+lab(300,765,'BACK'))
tf,kt=tee_front(); tb=tee_back(kt); pf,kp=pants_front(); pb=pants_back(kp)
TEE=[("Chest width","Straight across, 2.5 cm (1\") below the armpit, side to side."),
("Waist width","Straight across at the narrowest point between chest and hem."),
("Hem width","Straight across the bottom edge."),
("Body length (HPS)","From the high point of the shoulder (where shoulder seam meets collar) straight down to the hem."),
("Shoulder width","Shoulder seam point to shoulder seam point, straight across."),
("Armhole","Straight line from the shoulder seam point to the armpit."),
("Sleeve length","Shoulder seam point to the sleeve hem, along the top fold."),
("Underarm sleeve","Armpit to the sleeve hem, along the underside."),
("Bicep width","From the armpit, square across the sleeve to the top fold."),
("Sleeve opening","Across the sleeve hem, edge to edge."),
("Neck width","Collar seam to collar seam at the shoulder high points."),
("Front neck drop","From the line joining the two high points down to the collar seam at centre front."),
("Collar (rib) height","Width of the neck rib, at centre front."),
("Shoulder slope","Vertical drop from the high-point level down to the shoulder seam point."),
("Back neck drop","From the line joining the two high points down to the collar seam at centre back."),
("Centre back length","From the back collar seam at centre back straight down to the hem.")]
PANTS=[("Waist width","Straight across the top of the waistband, button closed, edge to edge."),
("Hip width","Straight across, 8 cm (3\") above the crotch point."),
("Thigh width","2.5 cm (1\") below the crotch, across one leg, square to the leg."),
("Knee width","Halfway down the inseam, square across the leg."),
("Calf width","Halfway between the knee line and the hem, square across the leg."),
("Leg opening","Across the hem, edge to edge."),
("Inseam","Crotch seam point to the hem, along the inside leg seam."),
("Outseam","Top of the waistband to the hem, along the side seam."),
("Front rise","Top of the waistband at centre front down to the crotch seam point."),
("Waistband height","Top edge to bottom edge of the waistband."),
("Front pocket opening","Along the pocket opening, waistband seam to side seam."),
("Back rise","Top of the waistband at centre back down to the crotch seam point."),
("Back pocket width","Across the top edge of the back pocket."),
("Back pocket length","From the top edge to the bottom point, at the pocket's centre.")]
def legend(items):
    rows=''.join(f'<div class="r"><span class="d" style="background:{C[i]}">{chr(65+i)}</span><div><b>{n}</b><br><span class="h">{h}</span></div></div>' for i,(n,h) in enumerate(items))
    return f'<div class="lg">{rows}</div>'
CSS='body{margin:0;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#1d2330}.pg{width:1500px;padding:28px 36px;box-sizing:border-box}h1{margin:0 0 6px;font-size:34px;letter-spacing:.02em}p.s{margin:0 0 14px;color:#5a6272;font-size:17px}.fig{display:flex;gap:40px;justify-content:center}.lg{display:grid;grid-template-columns:1fr 1fr;gap:12px 36px;margin-top:22px}.r{display:flex;gap:12px;align-items:flex-start;font-size:17px;line-height:1.35}.d{flex:none;width:34px;height:34px;border-radius:50%;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:18px}.h{color:#4a5263}'
for name,title,a,b,items in [("tshirt","T-SHIRT (SHORT SLEEVE) — POINTS OF MEASURE",tf,tb,TEE),("pants","LONG PANTS — POINTS OF MEASURE",pf,pb,PANTS)]:
    open(f'{name}.html','w').write(f'<html><head><meta charset="utf-8"><style>{CSS}</style></head><body><div class="pg"><h1>{title}</h1><p class="s">All widths are FLAT — measured across the garment lying flat, not doubled. Lay it smooth, buttons/zip closed.</p><div class="fig">{a}{b}</div>{legend(items)}</div></body></html>')
print(kt,kp)
