# photo-relay

## À quoi ça sert

Un Worker Cloudflare qui relaie des photos du téléphone vers le Pearboard. Depuis
n'importe où, on ouvre une page web (protégée par Cloudflare Access), on choisit une
photo et on ajoute une légende. La TV interroge le Worker avec un jeton secret, affiche
chaque photo en plein écran et la marque comme vue. Les messages sont stockés dans D1,
les photos dans R2. Détails : [design](../docs/plans/2026-10-12-remote-photos-design.md).

Limites : photo JPEG, PNG ou WebP (le type est vérifié sur les premiers octets, pas
sur ce que déclare le téléphone), 2 Mo au maximum (la page réduit la photo avant
l'envoi) ; légende de 200 caractères au maximum.

## Mise en place (une fois)

Toutes les commandes se lancent dans `photo-relay/`.

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create pearboard-photos`. Copier le `database_id` affiché dans
   `wrangler.toml`. Ce n'est pas un secret : il peut être commité.
4. `npx wrangler r2 bucket create pearboard-photos`
5. `npx wrangler d1 migrations apply pearboard-photos --remote`
6. `npx wrangler deploy`. Noter l'URL `https://pearboard-photos.<sous-domaine>.workers.dev`.
   `wrangler.toml` contient `preview_urls = false` : les URL de prévisualisation
   seraient hors de l'application Access, il faut les laisser désactivées.
7. **Cloudflare Access** (tableau de bord Cloudflare → Zero Trust ; choisir un nom
   d'équipe et le plan Free) :
   - Access → Applications → Add → Self-hosted. Domaine : l'hôte workers.dev.
     Politique « Famille » : Action **Allow**, Include **Emails**, vos adresses.
     Dans les réglages de l'application, mettre l'attribut de cookie **SameSite** à
     **Lax** (ou Strict) : couche de plus contre les requêtes venues d'autres sites
     (le Worker refuse déjà les POST/DELETE inter-sites via `Origin` /
     `Sec-Fetch-Site`). Enregistrer, puis copier l'**Application Audience (AUD) Tag**.
   - Deuxième application Self-hosted sur le même domaine, chemin `api/tv`.
     Politique : Action **Bypass**, Include **Everyone**. La TV y utilise son propre
     jeton.
8. Secrets, chacun saisi à l'invite :
   - `npx wrangler secret put ACCESS_TEAM_DOMAIN`, par ex. `monequipe.cloudflareaccess.com`
   - `npx wrangler secret put ACCESS_AUD` (le tag AUD de l'étape 7)
   - `npx wrangler secret put AUTHORS`, par ex. `tomy@…=Tomy;lily@…=Lily`
   - `npx wrangler secret put TV_TOKEN`, généré avec
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
     Le garder pour `PHOTOS_TOKEN` dans `android-board/local.properties`.
9. Vérifier :
   - sur un téléphone, l'URL demande le code reçu par courriel, puis affiche la page ;
   - `curl https://pearboard-photos.<sous-domaine>.workers.dev/api/tv/messages` sans
     jeton répond `{"error":"unauthorized"}`. Le contournement Access fonctionne et le
     jeton reste exigé.

## Ajouter une personne

Ajouter son adresse à la politique « Famille » de l'application Access, puis à
`AUTHORS` (`npx wrangler secret put AUTHORS` avec la liste complète). Sans entrée dans
`AUTHORS`, l'auteur affiché est la partie avant le `@`.

## Développer en local

Créer `photo-relay/.dev.vars` (ignoré par git) :

```
DEV_ACCESS_EMAIL=tomy@example.com
TV_TOKEN=dev-token
AUTHORS=tomy@example.com=Tomy
```

`DEV_ACCESS_EMAIL` remplace Access sous `wrangler dev`, seulement pour les requêtes
vers `localhost` et seulement si `ACCESS_AUD` n'est pas défini. Ne **pas** mettre
`ACCESS_AUD` (ni `ACCESS_TEAM_DOMAIN`) dans `.dev.vars`, sinon la page renvoie 403.

```bash
npx wrangler d1 migrations apply pearboard-photos --local
npm run dev     # page sur http://localhost:8787
npm test        # Vitest + pool Workers
```

Sous Windows, `npm test` peut afficher des avertissements `EBUSY` sur des dossiers
temporaires de miniflare : ils sont sans effet sur le résultat.

## Changer le jeton de la TV

1. `npx wrangler secret put TV_TOKEN` (nouvelle valeur générée comme ci-dessus).
2. Mettre la même valeur dans `PHOTOS_TOKEN` de `android-board/local.properties`.
3. Recompiler et réinstaller l'APK.
