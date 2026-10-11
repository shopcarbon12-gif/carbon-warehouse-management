import json,collections,re
g=json.load(open('gmc-all.json'))
s1={p['id']:p for p in json.load(open('audit/shop.json'))}
s2={p['id']:p for p in json.load(open('audit/shop2.json'))}
def attr(p,k): return (p.get('productAttributes') or p.get('attributes') or {}).get(k)
combos=collections.Counter((p['contentLanguage'],p['feedLabel'],p['dataSource'].split('/')[-1]) for p in g)
prim=[p for p in g if p['dataSource'].endswith('10723206162')]
byprod=collections.defaultdict(list)
for p in prim:
  m=re.match(r'shopify_\w+?_(\d+)_(\d+)',p['offerId'])
  if m: byprod[m.group(1)].append(p)
t_ok=t_n=d_seo=d_short=d_n=0; gt=0; ie=collections.Counter(); mpn=0; brand=collections.Counter(); ex=[]
for pid,offs in byprod.items():
  for o in offs:
    a=o.get('productAttributes') or o.get('attributes') or {}
    if a.get('gtins') or a.get('gtin'): gt+=1
    ie[str(a.get('identifierExists'))]+=1
    if a.get('mpn'): mpn+=1
    brand[a.get('brand')]+=1
  if pid not in s1 or not s1[pid].get('seo'): continue
  o=[x for x in offs if x['contentLanguage']=='en'][:1]
  if not o: continue
  a=o[0].get('productAttributes') or o[0].get('attributes') or {}
  t=a.get('title') or ''; d=a.get('description') or ''
  t_n+=1; t_ok+= t.startswith(s1[pid]['seo'][:40])
  if pid in s2 and s2[pid].get('meta'):
    d_n+=1; d_seo+= d.startswith(s2[pid]['meta'][:55]); d_short+= d.startswith(s2[pid]['short'][:55])
  if len(ex)<3: ex.append({'product':pid,'shopify_seo_title':s1[pid]['seo'],'gmc_title':t,'shopify_meta_first60':s2.get(pid,{}).get('meta'),'gmc_description_first120':d[:120]})
out={'gmc_offers_total':len(g),'language_feedlabel_source':{f'{k[0]}/{k[1]}/{k[2]}':v for k,v in combos.items()},
 'primary_products':len(byprod),
 'title_starts_with_shopify_seo_title':f'{t_ok}/{t_n}',
 'description_starts_with_shopify_seo_meta':f'{d_seo}/{d_n}','description_starts_with_short_desc':f'{d_short}/{d_n}',
 'offers_with_gtin':gt,'identifierExists':dict(ie),'offers_with_mpn':mpn,'brand':dict(brand),'examples':ex}
print(json.dumps(out,indent=1,ensure_ascii=False))
