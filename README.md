# Clap — montage vidéo sur iPad

Clap est une application web de montage vidéo pensée pour l'iPad : des vidéos
de 30 secondes à quelques minutes pour TikTok, Instagram ou YouTube, montées
au doigt, sans compte et sans envoyer ses vidéos sur internet.

## Fonctions

- Import des vidéos, photos et sons depuis Photos ou Fichiers (vidéos 4K comprises)
- Formats TikTok, Reel Instagram (9:16) et YouTube (16:9), modifiables à tout moment
- Découpe, rognage, réorganisation (appui long), duplication, suppression
- Ralenti et accéléré par clip (×0,25 à ×5), avec une voix qui garde son timbre
- Son : volume (jusqu'à 200 %), muet, fondus, son séparable de la vidéo
- Musique : 38 morceaux libres de droits intégrés (CC0) + import de ses propres sons et voix off
- Textes : 10 polices, 8 couleurs, styles simple, contour, fond et ombre ; déplacement, taille et rotation au doigt
- Cadrage par clip : remplir ou ajuster (fond flou), zoom, déplacement, rotation
- Annuler / rétablir, sauvegarde automatique, plusieurs projets
- Export MP4 1080p ou 4K, 30 ou 60 images/s, puis « Enregistrer la vidéo » ou partage direct

Tout le traitement se fait sur l'appareil (WebCodecs + Web Audio) : les vidéos
ne quittent jamais l'iPad.

## Utilisation sur iPad

1. Ouvrir l'adresse du site dans Safari.
2. Toucher **Partager**, puis **Sur l'écran d'accueil**.
3. Lancer Clap depuis son icône : il s'ouvre en plein écran comme une app, et
   ses projets sont protégés du nettoyage automatique de Safari.

## Développement

```bash
npm install
npm run dev      # serveur de développement
npm run build    # version de production dans dist/
```

## Mise en ligne

Le workflow `.github/workflows/deploy.yml` publie le site sur GitHub Pages à
chaque envoi sur la branche `main`. Il faut activer Pages une fois :
**Settings → Pages → Source : GitHub Actions**.

## Licences

- Polices : SIL Open Font License (paquets @fontsource).
- Musiques : domaine public CC0, voir `public/music/LICENCES.md`.
- Bibliothèque vidéo : Mediabunny (MPL-2.0).
