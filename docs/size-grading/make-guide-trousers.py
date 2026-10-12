"""Guide pictures for trousers (public/size-grading/guide/trousers-front.webp,
trousers-back.webp), numbered in pomsFor("trousers", view) order; colours =
POM_COLOR in size-grading-workspace.tsx."""
S='/tmp/claude-1000/-home-carbondev-dev-carbon-warehouse-management/49ccf484-ed34-40f9-8c3e-3c621d48251f/scratchpad/'
COL=dict(waist='#a855f7',hip='#22d3ee',thigh='#06b6d4',legOpening='#f43f5e',inseam='#22c55e',rise='#f472b6')
def T(x,y): return round(x*1.45+115,1), round(y*1.38+20,1)
def arrow(a,b,c,n,l):
    return (f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}" stroke="{c}" stroke-width="7" marker-start="url(#m{n})" marker-end="url(#m{n})"/>'
            f'<circle cx="{l[0]}" cy="{l[1]}" r="30" fill="{c}" stroke="#0b0d12" stroke-width="5"/>'
            f'<text x="{l[0]}" y="{l[1]+12}" text-anchor="middle" font-size="34" font-weight="800" fill="#0b0d12" font-family="Arial">{n}</text>')
pts=[(150,40),(450,40),(460,220),(435,720),(315,720),(300,290),(285,720),(165,720),(140,220)]
body='M'+' L'.join('%s,%s'%T(*p) for p in pts)+' Z'
def page(items, back):
    order=[k for k,_ in items]
    defs=''.join(f'<marker id="m{i+1}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="{COL[k]}"/></marker>' for i,k in enumerate(order))
    seam=' M'.join(['%s,%s L%s,%s'%(*T(151,75),*T(452,75))]+(['%s,%s L%s,%s'%(*T(300,75),*T(300,250))] if not back else ['%s,%s L%s,%s'%(*T(300,130),*T(300,288))]))
    extra=f'<path d="M{seam}" stroke="#7d8696" stroke-width="2.5" stroke-dasharray="9 7" fill="none"/>'
    if back:
        for x0 in (178,328):
            q=[T(x0,132),T(x0+94,132),T(x0+90,215),T(x0+47,232),T(x0+4,215)]
            extra+='<path d="M'+' L'.join('%s,%s'%p for p in q)+' Z" fill="none" stroke="#7d8696" stroke-width="2.5"/>'
    L=''.join(arrow(T(*a),T(*b),COL[k],i+1,T(*l)) for i,(k,(a,b,l)) in enumerate(items))
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 1100" width="1100" height="1100"><defs>{defs}</defs><rect width="1100" height="1100" fill="#0b0d12"/><path d="{body}" fill="#d9dde4" stroke="#9aa3b2" stroke-width="3" stroke-linejoin="round"/>{extra}{L}</svg>'
G={'waist':((151,57),(449,57),(240,57)),'hip':((142,232),(458,232),(380,232)),'thigh':((146,312),(298,312),(205,312)),
   'legOpening':((166,712),(284,712),(225,712)),'inseam':((306,296),(321,716),(345,520)),'rise':((292,42),(292,288),(262,170))}
front=['waist','hip','thigh','legOpening','inseam','rise']; back=['waist','hip','thigh','legOpening','inseam']
open(S+'trousers-front.svg','w').write(page([(k,G[k]) for k in front],False))
open(S+'trousers-back.svg','w').write(page([(k,G[k]) for k in back],True))
