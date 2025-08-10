// server.js (patched — supports Headless private token + debug endpoint)
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());

const SHOP_DOMAIN = process.env.SHOP_DOMAIN;            // e.g., jennatiboutique.com
const STOREFRONT_TOKEN = process.env.STOREFRONT_TOKEN;  // Storefront API token (Headless private or Storefront access)
const CURRENCY_SYMBOL = "€";

if(!SHOP_DOMAIN || !STOREFRONT_TOKEN){
  console.warn("Missing SHOP_DOMAIN or STOREFRONT_TOKEN env vars.");
}

// GraphQL fetch to Storefront API (Node 18+ has global fetch)
const GQL = async (query, variables = {}) => {
  const r = await fetch(`https://${SHOP_DOMAIN}/api/2024-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Send BOTH headers (public + private). Shopify ignores the unused one.
      "X-Shopify-Storefront-Access-Token": STOREFRONT_TOKEN,
      "Shopify-Storefront-Private-Token": STOREFRONT_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  if(!r.ok){
    const body = await r.text();
    throw new Error(`Storefront API HTTP ${r.status}: ${body}`);
  }
  const j = await r.json();
  if (j.errors) {
    throw new Error(JSON.stringify(j.errors));
  }
  return j.data;
};

// --- Utilities ---
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

function extractNotes(htmlOrText){
  const text = (htmlOrText || "").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
  const grab = (label) => {
    const m = text.match(new RegExp(`${label}\s*:\s*([^\.\n]+)`, "i"));
    return m ? m[1].split(/,|;|\/|·|•/).map(x=>x.trim()).filter(Boolean) : [];
  };
  return {
    notes_top:   grab("(Notes? de t(ê|e)te|Top Notes?)"),
    notes_heart: grab("(Notes? de c(œ|oe)ur|Heart Notes?)"),
    notes_base:  grab("(Notes? de fond|Base Notes?)"),
  };
}

function priceBand(amount){
  if(amount < 25) return "<25";
  if(amount <= 40) return "25-40";
  if(amount <= 60) return "40-60";
  return "+60";
}

function scoreProduct(p, a){
  let s = 0;
  // Gender match
  if(a.gender){
    if(a.gender === 'Mixte' && p.gender === 'unisex') s+=2;
    if(a.gender === 'Femme' && p.gender === 'femme') s+=2;
    if(a.gender === 'Homme' && p.gender === 'homme') s+=2;
  }
  // Profile via text
  const map = {'Floral':'floral','Fruité':'fruit','Gourmand':'gourmand','Boisé/Ambré':'bois|oud|ambr','Musqué':'musc','Frais/Agrumes':'frais|agrum|citron|bergamote','Épicé':'epic|poivr|safran|cardamome'};
  if(a.profile){
    const re = new RegExp(map[a.profile]||"", "i");
    if(re.test(p.profileText)) s+=3;
  }
  // Intensity (heuristics)
  if(a.intensity){
    if(a.intensity === 'Douce' && /doux|léger|subtil/i.test(p.profileText)) s+=1;
    if(a.intensity === 'Modérée' && /mod(é|e)r(é|e)/i.test(p.profileText)) s+=1;
    if(a.intensity === 'Marquée' && /fort|intense|puissant/i.test(p.profileText)) s+=1;
  }
  // Occasion
  if(a.occasion){
    const o = a.occasion.includes('Mariage') ? 'mariage|ev(è|e)nement' :
              a.occasion.includes('Tous') ? 'quotidien|tous les jours|daily' :
              a.occasion.toLowerCase();
    if(new RegExp(o,"i").test(p.profileText)) s+=1;
  }
  // Budget
  if(a.budget && p.price_band === ({ "<25€":"<25", "25–40€":"25-40", "40–60€":"40-60", "+60€":"+60" }[a.budget])) s+=2;
  // Format
  if(a.format && a.format.startsWith('Huile') && /huile|musc/i.test(p.profileText)) s+=2;
  if(a.format === 'Eau de parfum' && /eau de parfum|edp/i.test(p.profileText)) s+=1;
  // Sensitivity
  if(a.sensitivity === 'Oui' && /fort|intense|puissant/i.test(p.profileText)) s-=1;
  return s;
}

// Memory cache (15 min)
let cache = { at: 0, items: [] };

async function loadCatalog(){
  const now = Date.now();
  if (now - cache.at < 15*60*1000 && cache.items.length) return cache.items;

  const items = [];
  let cursor = null;
  const query = \`
    query AllProducts($cursor: String){
      products(first: 100, after: $cursor, query:"-status:ARCHIVED"){
        pageInfo{ hasNextPage }
        edges{
          cursor
          node{
            id handle title vendor productType tags
            descriptionHtml
            images(first:1){ edges{ node{ url } } }
            variants(first:1){ edges{ node{ id price { amount currencyCode } } } }
          }
        }
      }
    }\`;

  while(true){
    const data = await GQL(query, { cursor });
    const edges = data?.products?.edges || [];
    for(const edge of edges){
      const n = edge.node;
      const v = n.variants?.edges?.[0]?.node;
      const price = Number(v?.price?.amount || 0);
      const img = n.images?.edges?.[0]?.node?.url || `https://${SHOP_DOMAIN}/cdn/shop/products/${n.handle}.jpg`;
      const { notes_top, notes_heart, notes_base } = extractNotes(n.descriptionHtml);
      const profileBits = [
        ...(n.tags || []), n.title || "", n.vendor || "", n.productType || "",
        notes_top.join(" "), notes_heart.join(" "), notes_base.join(" "),
        (n.descriptionHtml || "").replace(/<[^>]+>/g," ")
      ].join(" ");
      // Gender heuristics
      let gender = "unisex";
      const t = norm(profileBits);
      if(/femme|women|ladies/.test(t)) gender = "femme";
      if(/homme|men|gent/.test(t)) gender = (gender==="femme"?"unisex":"homme");

      items.push({
        id: n.id,
        handle: n.handle,
        title: n.title,
        brand: n.vendor || "",
        gender,
        notes_top, notes_heart, notes_base,
        price,
        price_band: priceBand(price),
        image: img,
        url: `https://${SHOP_DOMAIN}/products/${n.handle}`,
        variantId: v?.id || ""
      });
      cursor = edge.cursor;
    }
    const hasNext = data?.products?.pageInfo?.hasNextPage;
    if(!hasNext) break;
  }

  cache = { at: now, items };
  return items;
}

app.get("/apps/jb-reco", async (req,res) => {
  try{
    const answers = JSON.parse(req.query.q || "{}");
    const catalog = await loadCatalog();

    const enriched = catalog.map(p => {
      const profileText = [
        p.title, p.brand, p.gender,
        p.notes_top.join(" "), p.notes_heart.join(" "), p.notes_base.join(" ")
      ].join(" ");
      return { ...p, profileText };
    });

    const scored = enriched
      .map(p => ({ p, s: scoreProduct(p, answers) }))
      .sort((a,b) => b.s - a.s)
      .slice(0,5)
      .map(({p}) => ({
        title: p.title,
        url: p.url,
        image: p.image,
        price: `${p.price.toFixed(2)} ${CURRENCY_SYMBOL}`,
        badge: [p.brand, p.gender].filter(Boolean).join(" • "),
        variantId: p.variantId
      }));

    res.json({ items: scored });
  } catch(e){
    console.error(e);
    res.status(500).json({ error: "server_error", detail: String(e) });
  }
});

// Debug: check if products are visible to your token
app.get("/debug", async (_req,res) => {
  try{
    const items = await loadCatalog();
    res.json({ count: items.length, sample: items.slice(0,3).map(p=>({title:p.title, price:p.price, url:p.url})) });
  } catch(e){
    res.status(500).json({ error: "server_error", detail: String(e) });
  }
});

app.get("/", (_req,res)=>res.send("OK"));
export default app;

