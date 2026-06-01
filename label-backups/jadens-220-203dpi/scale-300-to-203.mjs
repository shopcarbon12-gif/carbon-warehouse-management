import { execSync } from "node:child_process";
const s = 203/300;
const R = (n) => Math.round(Number(n) * s);
function scale(zpl) {
  return zpl
    .replace(/\^PW(\d+)/g, (_,n)=>`^PW${R(n)}`)
    .replace(/\^LL(\d+)/g, (_,n)=>`^LL${R(n)}`)
    .replace(/\^LS(-?\d+)/g, (_,n)=>`^LS${R(n)}`)
    .replace(/\^LT(-?\d+)/g, (_,n)=>`^LT${R(n)}`)
    .replace(/\^(FO|FT)(-?\d+),(-?\d+)/g, (_,c,x,y)=>`^${c}${R(x)},${R(y)}`)
    .replace(/\^GB(\d+),(\d+),(\d+)/g, (_,w,h,t)=>`^GB${R(w)},${R(h)},${Math.max(1,R(t))}`)
    .replace(/\^BY(\d+)(,\d+(?:\.\d+)?)?(,\d+)?/g, (_,m,r,h)=>`^BY${Math.max(1,R(m))}${r??""}${h?","+R(h.slice(1)):""}`)
    .replace(/\^A([A-Z0-9])([NBRI]),(\d+)(,\d+)?/g, (_,f,o,h,w)=>`^A${f}${o},${R(h)}${w?","+R(w.slice(1)):""}`)
    .replace(/\^FB(\d+),(\d+),(\d+),([LCRJ])/g, (_,w,l,sp,j)=>`^FB${R(w)},${l},${R(sp)},${j}`)
    .replace(/\^BA([NBRI]),(\d+)/g, (_,o,h)=>`^BA${o},${R(h)}`)
    .replace(/\^BC([NBRI]),(\d+)/g, (_,o,h)=>`^BC${o},${R(h)}`);
}
const out = execSync('npx tsx -e \'' +
  'import { generateCarbonTagZpl, stripRfidEncoding, DEFAULT_CARBON_TAG_SETTINGS } from "./lib/utils/zpl-carbon-tag.ts";' +
  'const z = generateCarbonTagZpl({ input:{ itemName:"FASHION HOODIE AA", color:"YELLOW", size:"XXXL", upc:"1982451", customSku:"C319824511006", retailPrice:"92.00", sizesAvailable:"L M S XS XL XXL XXXL" }, settings: DEFAULT_CARBON_TAG_SETTINGS, epcWrite:{companyPrefix:985611,itemNumber:210000003688,serialNumber:994001} });' +
  'process.stdout.write(stripRfidEncoding(z));\'', {encoding:"utf8"});
const scaled = scale(out);
import("node:fs").then(fs=>fs.writeFileSync("/tmp/jadens220-scaled.zpl", scaled));
console.log(scaled);
