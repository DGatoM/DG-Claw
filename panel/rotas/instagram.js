const fs = require('fs');
const path = require('path');
const { readJSON, readJSONL, readJSONLLast, todayStr } = require('../lib/readers');

// Rotas do poder `instagram`: posts, comentários e seguidores.

module.exports = function registrar(router, ctx) {
  const { CONFIG, P, TZ, requirePower } = ctx;

  // ─── API: Posts (poder instagram) ─────────────────────────────

  router.get('/api/posts', requirePower('instagram'), (req, res) => {
    const limit = parseInt(req.query.limit || '30');
    const date = req.query.date;

    let posts;
    if (date) {
      posts = readJSONL(P.POSTS_FILE, date);
    } else {
      posts = readJSONLLast(P.POSTS_FILE, limit);
    }

    const allStories = date ? readJSONL(P.STORIES_FILE, date) : readJSONLLast(P.STORIES_FILE, limit);
    for (const post of posts) {
      post.hasStory = false;
      for (const story of allStories) {
        const feedUrl = story.feedPostUrl || story.postFeedUrl || '';
        if (post.postUrl && feedUrl && feedUrl.includes(post.postUrl)) {
          post.hasStory = true;
          post.storyPublished = [true, 'OK', 'true'].includes(story.published);
          break;
        }
      }
    }

    res.json({ count: posts.length, posts: posts.reverse() });
  });

  router.get('/api/posts/stats', requirePower('instagram'), (req, res) => {
    const allPosts = readJSONL(P.POSTS_FILE);
    const today = todayStr(TZ);
    const todayPosts = allPosts.filter((p) => p.date === today);

    let streak = 0;
    const dates = [...new Set(allPosts.map((p) => p.date))].sort().reverse();
    const offset = typeof TZ === 'number' ? TZ : -3;
    const sign = offset < 0 ? '-' : '+';
    const oh = String(Math.abs(offset)).padStart(2, '0');
    const d = new Date(today + `T12:00:00${sign}${oh}:00`);
    for (let i = 0; i < 365; i++) {
      const dateStr = d.toISOString().split('T')[0];
      if (dates.includes(dateStr)) {
        streak++;
      } else if (i > 0) {
        break;
      }
      d.setDate(d.getDate() - 1);
    }

    res.json({ total: allPosts.length, today: todayPosts.length, streak });
  });

  // ─── API: Comments (poder instagram) ──────────────────────────

  router.get('/api/comments/recent', requirePower('instagram'), (req, res) => {
    const recent = readJSONLLast(P.COMMENTS_FILE, 20);
    const pending = readJSON(P.PENDING_FILE);

    const sentiments = { positive: 0, neutral: 0, negative: 0 };
    const positiveKeys = new Set(['elogio', 'positive', 'recomendacao']);
    const negativeKeys = new Set(['spam', 'injection', 'negative']);
    for (const c of recent) {
      const s = c.sentiment || 'unknown';
      if (positiveKeys.has(s)) sentiments.positive++;
      else if (negativeKeys.has(s)) sentiments.negative++;
      else sentiments.neutral++;
    }

    let totalReplied = 0;
    try {
      const data = fs.readFileSync(P.REPLIED_FILE, 'utf-8');
      totalReplied = data.split('\n').filter((l) => l.trim()).length;
    } catch { /* not found */ }

    res.json({
      recent: recent.reverse(),
      pending: Array.isArray(pending) ? pending : [],
      pendingCount: Array.isArray(pending) ? pending.length : 0,
      sentiments,
      totalReplied,
    });
  });

  // ─── API: Followers (poder instagram) ─────────────────────────

  router.get('/api/followers/top', requirePower('instagram'), (req, res) => {
    const raw = readJSON(P.RELATIONSHIPS_FILE);
    const rels = raw.relationships || raw;
    const owner = rels[CONFIG.creatorKey] || null;
    const topFollowers = rels.top_followers || {};

    const followersArray = Object.entries(topFollowers).map(([username, data]) => ({
      username,
      ...data,
    }));

    res.json({
      agent_owner: owner, // bloco do dono no painel
      owner,
      top_followers: followersArray,
    });
  });

  router.get('/api/followers/stats', requirePower('instagram'), (req, res) => {
    const tiers = { newcomer: 0, returning: 0, regular: 0, close: 0, negative: 0 };
    let total = 0;

    try {
      const files = fs.readdirSync(P.FOLLOWERS_DIR);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(P.FOLLOWERS_DIR, f), 'utf-8'));
          const tier = data.tier || 'newcomer';
          tiers[tier] = (tiers[tier] || 0) + 1;
          total++;
        } catch { continue; }
      }
    } catch { /* dir not found */ }

    res.json({ total, tiers });
  });
};
