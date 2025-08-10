
# JB Reco Backend (Shopify Storefront)

Backend simple pour recommander des parfums à partir du catalogue Shopify via Storefront API.

## Déploiement rapide (Vercel)

1. Crée un projet Vercel et importe ce dossier.
2. Ajoute deux variables d'environnement :
   - `SHOP_DOMAIN` = `jennatiboutique.com`
   - `STOREFRONT_TOKEN` = **Storefront Access Token** (Shopify Admin → Développer des apps → Créer une app → Storefront API).
3. Déploie. L'URL (ex. `https://jb-reco.vercel.app`) est ton endpoint.
4. Dans Shopify, configure **App Proxy** pour `apps/jb-reco` vers `https://TON_URL/apps/jb-reco`.

## Local
```bash
npm install
SHOP_DOMAIN=jennatiboutique.com STOREFRONT_TOKEN=XXXX node server.js
```
