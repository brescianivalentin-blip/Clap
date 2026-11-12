"""Construit la bibliothèque musicale de Clap (morceaux CC0, volume harmonisé à -16 LUFS).

Sources : Open Lo-Fi (github.com/btahir/open-lofi) et la copie de FreePD (github.com/0lhi/FreePD).
"""
import json, os, re, subprocess, sys, zipfile
# Usage : python3 build-music-library.py <openlofi.zip> <lofi-catalog.json> <clone de github.com/0lhi/FreePD> <dossier de sortie>
LOFI_ZIP, LOFI_CATALOG, REPO, OUT = sys.argv[1:5]
REPO = REPO.rstrip('/') + '/'
OUT = OUT.rstrip('/') + '/'
WORK = OUT + '.work/'
os.makedirs(OUT, exist_ok=True); os.makedirs(WORK, exist_ok=True)
lofi = {t['filename']: t['title'] for t in json.load(open(LOFI_CATALOG))['tracks']}
sel = [
  ('Joyeux', 'freepd', 'Upbeat/Happy Whistling Ukulele.mp3'), ('Joyeux', 'freepd', 'Upbeat/Ukulele Song.mp3'),
  ('Joyeux', 'freepd', 'Upbeat/City Sunshine.mp3'), ('Joyeux', 'freepd', 'Upbeat/Funshine.mp3'),
  ('Joyeux', 'freepd', 'Upbeat/Be Chillin.mp3'), ('Joyeux', 'freepd', 'Upbeat/And Just Like That.mp3'),
  ('Joyeux', 'freepd', 'Upbeat/Inspiration.mp3'), ('Joyeux', 'freepd', 'Upbeat/Pickled Pink.mp3'),
  ('Joyeux', 'freepd', 'Comedy/Silly Intro.mp3'), ('Joyeux', 'freepd', 'Comedy/Spring Chicken.mp3'),
  ('Chill', 'lofi', 'sunset-offbeat.mp3'), ('Chill', 'lofi', 'window-seat-daydream.mp3'),
  ('Chill', 'lofi', 'porchlight-golden-hour.mp3'), ('Chill', 'lofi', 'soft-gold-sky.mp3'),
  ('Chill', 'lofi', 'glow-on-the-overpass.mp3'), ('Chill', 'lofi', 'summer-curbside-glow.mp3'),
  ('Chill', 'lofi', 'roller-rink-reverie.mp3'), ('Chill', 'lofi', 'golden-afternoon-groove.mp3'),
  ('Chill', 'lofi', 'breezy-afternoon-terrace.mp3'), ('Chill', 'lofi', 'first-coffee-thoughts.mp3'),
  ('Chill', 'lofi', 'pancakes-in-the-sun.mp3'), ('Chill', 'lofi', 'sunrise-stretch-flow.mp3'),
  ('Énergique', 'freepd', 'Electronic/Backbeat.mp3'), ('Énergique', 'freepd', 'Electronic/Beat One.mp3'),
  ('Énergique', 'freepd', 'Electronic/Hippety Hop.mp3'), ('Énergique', 'freepd', 'Electronic/Fireworks.mp3'),
  ('Énergique', 'freepd', 'Electronic/Favorite.mp3'),
  ('Doux', 'freepd', 'Romance/Lovely Piano Song.mp3'), ('Doux', 'freepd', 'Romance/Nostalgic Piano.mp3'),
  ('Doux', 'freepd', 'Romance/Romantic Inspiration.mp3'), ('Doux', 'freepd', 'Romance/Champ de tournesol.mp3'),
  ('Doux', 'lofi', 'slow-dance-in-the-living-room.mp3'),
  ('Voyage', 'freepd', 'World/Sunny Rasta.mp3'), ('Voyage', 'freepd', 'World/Le Baguette.mp3'),
  ('Voyage', 'freepd', 'World/Bollywood Groove.mp3'), ('Voyage', 'lofi', 'cafe-da-tarde.mp3'),
  ('Voyage', 'lofi', 'savanna-slow-glow.mp3'), ('Voyage', 'freepd', 'World/Nomadic Sunset.mp3'),
]
paths = [p for _, src, p in sel if src == 'freepd']
subprocess.run(['git', '-C', REPO, 'checkout', 'HEAD', '--'] + paths, check=True, capture_output=True)
z = zipfile.ZipFile(LOFI_ZIP)
slug = lambda s: re.sub(r'[^a-z0-9]+', '-', s.lower().replace('é', 'e')).strip('-')
tracks = []
for mood, src, p in sel:
    if src == 'freepd':
        inp = REPO + p
        title = os.path.splitext(os.path.basename(p))[0]
        artist, source = 'FreePD', 'FreePD (freepd.com), domaine public CC0'
    else:
        inp = WORK + p
        with open(inp, 'wb') as f: f.write(z.read(p))
        title = lofi[p]
        artist, source = 'Open Lo-Fi', 'Open Lo-Fi (github.com/btahir/open-lofi), domaine public CC0'
    name = slug(title) + '.m4a'
    out = OUT + name
    r = subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', inp, '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
                        '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], capture_output=True, text=True)
    if r.returncode != 0:
        print('FAIL', p, r.stderr[:200]); continue
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], capture_output=True, text=True).stdout.strip())
    tracks.append({'id': slug(title), 'title': title, 'artist': artist, 'mood': mood, 'duration': round(dur, 2), 'file': name, 'license': 'CC0-1.0', 'source': source})
    print(f'{mood:10} {title:40} {dur:6.1f}s {os.path.getsize(out)//1024} KB')
json.dump({'version': 1, 'license': 'CC0-1.0', 'tracks': tracks}, open(OUT + 'catalog.json', 'w'), ensure_ascii=False, indent=1)
print(len(tracks), 'tracks')
import shutil; shutil.rmtree(WORK, ignore_errors=True)
