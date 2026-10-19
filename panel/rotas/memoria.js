const fs = require('fs');
const path = require('path');
const { resolveStateFile } = require('../lib/extensions');
const { readJSON, readJSONLLast, readFile, listDir, fileMtime } = require('../lib/readers');

// Memória, personalidade, identidade, memória de trabalho, changelog e diário do agente.

module.exports = function registrar(router, ctx) {
  const { P, isPathAllowed, explicarRecusa, TETO_LEITURA_BYTES } = ctx;

  // ─── API: Memory ──────────────────────────────────────────────

  router.get('/api/memory', (req, res) => {
    const memoryFiles = listDir(P.MEMORY_DIR, ['.md', '.json']);
    const mainMemory = { name: 'MEMORY.md', size: 0, modified: '', isMain: true };
    try {
      const stat = fs.statSync(P.MEMORY_FILE);
      mainMemory.size = stat.size;
      mainMemory.modified = stat.mtime.toISOString();
    } catch { /* not found */ }

    res.json({ main: mainMemory, files: memoryFiles });
  });

  router.get('/api/memory/file', (req, res) => {
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).json({ error: 'path required' });

    if (!isPathAllowed(requestedPath)) {
      // O motivo vai junto (sem caminho de servidor): "access denied" sozinho não
      // diz à pessoa se o arquivo é secreto ou se ela digitou errado.
      return res.status(403).json({ error: 'access denied', motivo: explicarRecusa(requestedPath) });
    }

    const fullPath = path.resolve(P.AGENT_DIR, requestedPath);
    // Teto de leitura: arquivo de vários MB aqui não é memória (é log ou transcript),
    // e lê-lo inteiro para mandar ao navegador só gasta a RAM do painel.
    try {
      if (fs.statSync(fullPath).size > TETO_LEITURA_BYTES) {
        return res.status(413).json({ error: 'arquivo grande demais para abrir aqui', motivo: 'passa de 2 MB' });
      }
    } catch { /* ausente: o readFile abaixo devolve null e a rota responde 404 */ }
    const content = readFile(fullPath);
    if (content === null) return res.status(404).json({ error: 'not found' });

    if (fullPath.endsWith('.json')) {
      try {
        return res.json({ path: requestedPath, type: 'json', content: JSON.parse(content) });
      } catch { /* serve as text */ }
    }

    res.json({ path: requestedPath, type: 'text', content });
  });

  // ─── API: Personality ─────────────────────────────────────────

  router.get('/api/personality', (req, res) => {
    const opinions = readJSON(P.OPINIONS_FILE);
    const proactivity = readJSON(resolveStateFile(P.PROACTIVITY_FILE, P.PROACTIVITY_FILE_LEGACY));
    const personality = readFile(P.PERSONALITY_FILE) || '';

    const bigFive = {};
    const bfMatches = personality.matchAll(/\|\s*([\wçãéêáà]+(?:\s+[\wçãéêáà]+)*)\s*\|\s*(\d+)\/10/gi);
    for (const m of bfMatches) {
      bigFive[m[1].trim().toLowerCase()] = parseInt(m[2]);
    }
    const headerMatches = personality.matchAll(/###\s+(.+?)\s*\((\d+)\/10\)/g);
    for (const m of headerMatches) {
      bigFive[m[1].trim().toLowerCase()] = parseInt(m[2]);
    }

    const proSettings = proactivity.settings || proactivity;

    res.json({
      bigFive,
      opinions: opinions.opinions || opinions,
      proactivity: {
        initiative: proSettings.initiative_level || 0,
        humor: proSettings.humor_level || 0,
        curiosity: proSettings.curiosity_level || 0,
        stubbornness: proSettings.stubbornness_level || 0,
      },
      thoughtBuffer: proactivity.thoughtBuffer || [],
      personalityModified: fileMtime(P.PERSONALITY_FILE),
      proactivityModified: fileMtime(resolveStateFile(P.PROACTIVITY_FILE, P.PROACTIVITY_FILE_LEGACY)),
      opinionsModified: fileMtime(P.OPINIONS_FILE),
    });
  });

  // ─── API: Identity ────────────────────────────────────────────

  router.get('/api/identity', (req, res) => {
    res.json({
      soul: readFile(P.SOUL_FILE) || '',
      personality: readFile(P.PERSONALITY_FILE) || '',
      identity: readFile(P.IDENTITY_FILE) || '',
      ethics: readFile(P.ETHICS_FILE) || '',
      laws: readFile(P.LAWS_FILE) || '',
      // Mesmo lugar onde o leitor (/api/memoria/arquivo) procura: a lista só mostra o que ele abre.
      creator: readFile(path.join(P.AGENT_DIR, 'CREATOR.md')) || '',
    });
  });

  // ─── API: Working Memory ─────────────────────────────────────

  router.get('/api/working-memory', (req, res) => {
    const arqWM = resolveStateFile(P.WORKING_MEMORY_FILE, P.WORKING_MEMORY_FILE_LEGACY);
    const content = readFile(arqWM);
    if (content === null) {
      // Agente novo pode não ter working-memory ainda.
      return res.json({ content: '', lastModified: null, size: 0 });
    }

    let lastModified = '';
    try {
      lastModified = fs.statSync(arqWM).mtime.toISOString();
    } catch { /* not found */ }

    res.json({ content, lastModified, size: (content || '').length });
  });

  // ─── API: Personality Changelog ──────────────────────────────

  router.get('/api/personality/changelog', (req, res) => {
    const content = readFile(P.PERSONALITY_CHANGELOG);
    if (content === null) return res.json({ content: 'Nenhum changelog encontrado' });
    res.json({ content });
  });

  // ─── API: Diary ───────────────────────────────────────────────

  router.get('/api/diary', (req, res) => {
    const limit = parseInt(req.query.limit || '20');
    const entries = readJSONLLast(P.DIARY_FILE, limit);
    res.json({ entries: entries.reverse() });
  });
};
