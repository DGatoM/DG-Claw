const fs = require('fs');
const path = require('path');

// Rotas do poder `meetings`: reuniões e o áudio de cada uma.

module.exports = function registrar(router, ctx) {
  const { P, meetings, requirePower } = ctx;

  // ─── API: Reuniões (poder meetings) ───────────────────────────

  router.get('/api/reunioes', requirePower('meetings'), (req, res) => {
    const q = (req.query.q || '').trim();
    const items = q ? meetings.searchMeetings(q) : meetings.listMeetings();
    res.json({ items, count: items.length });
  });

  router.get('/api/reunioes/:id', requirePower('meetings'), (req, res) => {
    const m = meetings.getMeeting(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    res.json(m);
  });

  // Stream do audio.raw como WAV (16kHz mono 16-bit LE)
  router.get('/api/reunioes/:id/audio.wav', requirePower('meetings'), (req, res) => {
    const id = req.params.id;
    if (!/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(id)) return res.status(400).send('bad id');
    const raw = path.join(P.MEETINGS_DIR, id, 'audio.raw');
    let stat;
    try { stat = fs.statSync(raw); } catch { return res.status(404).send('no audio'); }
    const dataLen = stat.size;
    const sr = 16000;
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0);
    hdr.writeUInt32LE(36 + dataLen, 4);
    hdr.write('WAVE', 8);
    hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16);
    hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(sr, 24);
    hdr.writeUInt32LE(sr * 2, 28);
    hdr.writeUInt16LE(2, 32);
    hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36);
    hdr.writeUInt32LE(dataLen, 40);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', 44 + dataLen);
    res.write(hdr);
    fs.createReadStream(raw).pipe(res);
  });
};
