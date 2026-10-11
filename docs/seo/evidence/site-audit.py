import json,re,urllib.request,sys
UA={"User-Agent":"Mozilla/5.0 (compatible; CarbonAudit/1.0)"}
def get(u):
  try:
    r=urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=30); return r.status,r.read().decode("utf8","ignore"),r.geturl()
  except urllib.error.HTTPError as e: return e.code,"",u
urls=["https://shopcarbon.com/","https://shopcarbon.com/products/alex-denim-shorts","https://shopcarbon.com/products/kiera-dress","https://shopcarbon.com/products/kiera-dress?variant=1","https://shopcarbon.com/collections/men","https://shopcarbon.com/collections/men?sort_by=price-ascending","https://shopcarbon.com/collections/men?page=2","https://shopcarbon.com/es/products/alex-denim-shorts","https://shopcarbon.com/pt/products/alex-denim-shorts","https://shopcarbon.com/products/startdust-denim-jacket","https://shopcarbon.com/pages/retail-store-locator"]
out=[]
for u in urls:
  st,h,final=get(u)
  can=(re.search(r'<link rel="canonical" href="([^"]+)"',h) or [None,None])[1]
  hl=re.findall(r'<link[^>]+hreflang="([^"]+)"[^>]+href="([^"]+)"',h) or [(m[1],m[0]) for m in re.findall(r'<link[^>]+href="([^"]+)"[^>]+hreflang="([^"]+)"',h)]
  robots=(re.search(r'<meta name="robots" content="([^"]+)"',h) or [None,None])[1]
  title=(re.search(r'<title>\s*(.*?)\s*</title>',h,re.S) or [None,""])[1]
  ld=[];
  for b in re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>',h,re.S):
    try:
      d=json.loads(b); ld.append(d.get("@type") if isinstance(d,dict) else "list")
      if isinstance(d,dict) and d.get("@type")=="ProductGroup":
        v=d.get("hasVariant",[]); off=[x.get("offers",{}) for x in v]
        ld.append(f"variants={len(v)} with_price={sum(1 for o in off if o.get('price'))} with_avail={sum(1 for o in off if o.get('availability'))} gtin={sum(1 for x in v if x.get('gtin') or x.get('gtin13') or x.get('gtin12'))} sku={sum(1 for x in v if x.get('sku'))}")
    except Exception as e: ld.append("INVALID JSON")
  out.append({"url":u,"status":st,"final":final if final!=u else "","title":title[:90],"canonical":can,"robots":robots,"hreflang":[a for a,b in hl],"jsonld":ld})
st,robotstxt,_=get("https://shopcarbon.com/robots.txt")
print(json.dumps(out,indent=1))
print("ROBOTS disallow sample:",[l for l in robotstxt.splitlines() if l.lower().startswith(("disallow","sitemap"))][:12])
