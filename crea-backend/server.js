const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ exposedHeaders: ['Content-Disposition'] }));

function isValidUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Prépare les arguments communs pour yt-dlp (moteur JS Node + solver EJS + cookies Render/local)
function getBaseYtDlpArgs() {
  const args = [
    '--force-ipv4',
    '--js-runtimes', 'deno,node',
    '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:player_client=tv,mweb,web',
  ];

  const renderSecret = '/etc/secrets/cookies.txt';
  const localCookies = path.join(__dirname, 'cookies.txt');
  const source = fs.existsSync(renderSecret)
    ? renderSecret
    : (fs.existsSync(localCookies) ? localCookies : null);

  if (source) {
    // Copie dans /tmp car /etc/secrets est en lecture seule sur Render
    const tmpCookies = path.join(os.tmpdir(), 'cookies.txt');
    try {
      fs.copyFileSync(source, tmpCookies);
      args.push('--cookies', tmpCookies);
    } catch {
      args.push('--cookies', source);
    }
  }

  return args;
}

// Vérification que le serveur tourne
app.get('/health', (_req, res) => res.json({ ok: true }));

// Récupérer les infos (titre, miniature, durée) avant de télécharger
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!isValidUrl(url)) return res.status(400).json({ error: 'URL invalide' });

  const child = spawn('yt-dlp', [
    ...getBaseYtDlpArgs(),
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--ignore-no-formats-error',
    url,
  ]);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  child.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: 'Impossible de lire ce lien', details: stderr.trim() });
    }
    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title || 'Sans titre',
        thumbnail: info.thumbnail || '',
        duration: info.duration || 0,
        uploader: info.uploader || '',
      });
    } catch {
      res.status(500).json({ error: 'Erreur de lecture des métadonnées' });
    }
  });
});

// Télécharger la vidéo ou extraire le son
app.get('/api/download', (req, res) => {
  const { url, type = 'video', quality = 'best', format = 'mp3' } = req.query;
  if (!isValidUrl(url)) return res.status(400).json({ error: 'URL invalide' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crea-dl-'));
  const outTpl = path.join(tmpDir, '%(title).80s.%(ext)s');
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  let args;
  if (type === 'audio') {
    const audioFmt = ['mp3', 'm4a', 'wav'].includes(format) ? format : 'mp3';
    args = [
      '-x',
      '--audio-format', audioFmt,
      '--audio-quality', '0',
      '--no-playlist',
      '--restrict-filenames',
      '-o', outTpl,
      url,
    ];
  } else {
    const allowedQ = ['1080', '720', '480'];
    const selector = allowedQ.includes(quality)
      ? `bv*[height<=${quality}]+ba/b[height<=${quality}]/bv*+ba/b`
      : 'bv*+ba/b';

    args = [
      '-f', selector,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--restrict-filenames',
      '-o', outTpl,
      url,
    ];
  }

  const child = spawn('yt-dlp', [...getBaseYtDlpArgs(), ...args]);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));

  // Si l'utilisateur ferme la page pendant le téléchargement
  req.on('close', () => {
    if (!res.writableEnded) {
      child.kill('SIGKILL');
      cleanup();
    }
  });

  child.on('close', (code) => {
    if (code !== 0) {
      cleanup();
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Échec du téléchargement', details: stderr.trim() });
      }
      return;
    }

    const files = fs.readdirSync(tmpDir).filter((f) => !f.endsWith('.part'));
    if (!files.length) {
      cleanup();
      return res.status(500).json({ error: 'Fichier introuvable après conversion' });
    }

    const filePath = path.join(tmpDir, files[0]);
    res.download(filePath, files[0], () => cleanup());
  });
});

app.listen(PORT, () => console.log(`Backend prêt sur http://localhost:${PORT}`));