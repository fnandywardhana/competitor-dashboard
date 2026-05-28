/**
 * Cloudflare Pages Function - wildcard route handler
 *
 * Routes:
 *   GET /api/index         → data/reports/index.json (list semua laporan)
 *   GET /api/report/:date  → data/reports/YYYY-MM-DD.json (detail laporan)
 *   GET /api/history       → data/history/*.json (semua history app)
 *
 * Env vars (set di Cloudflare Pages Settings → Environment Variables):
 *   GITHUB_TOKEN   - PAT fine-grained, repo Contents read-only
 *   GITHUB_OWNER   - username GitHub
 *   GITHUB_REPO    - nama repo (competitor-analysis)
 */

const GH = "https://api.github.com";
const CACHE_SECONDS = 300; // 5 menit

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Strip /api prefix
  const path = url.pathname.replace(/^\/api/, '') || '/';

  const token = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    return err("Server belum dikonfigurasi. Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO di Cloudflare Pages.", 500);
  }

  const gh = (p) => fetch(`${GH}/repos/${owner}/${repo}/contents/${p}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "competitor-dashboard",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cf: { cacheTtl: CACHE_SECONDS },
  });

  try {
    // GET /api/index
    if (path === '/index') {
      const r = await gh('data/reports/index.json');
      if (r.status === 404) return json([]);
      if (!r.ok) return err(`GitHub ${r.status}`, r.status);
      const file = await r.json();
      const content = JSON.parse(atob(file.content.replace(/\n/g, '')));
      return json(content);
    }

    // GET /api/report/YYYY-MM-DD
    const reportMatch = path.match(/^\/report\/(\d{4}-\d{2}-\d{2})$/);
    if (reportMatch) {
      const date = reportMatch[1];
      const r = await gh(`data/reports/${date}.json`);
      if (r.status === 404) return err('Laporan tidak ditemukan', 404);
      if (!r.ok) return err(`GitHub ${r.status}`, r.status);
      const file = await r.json();
      const content = JSON.parse(atob(file.content.replace(/\n/g, '')));
      return json(content);
    }

    // GET /api/history — fetch semua file history (parallel, batched)
    if (path === '/history') {
      const listR = await gh('data/history');
      if (!listR.ok) return err(`GitHub ${listR.status}`, listR.status);
      const files = await listR.json();
      const jsonFiles = files.filter(f => f.name.endsWith('.json') && f.type === 'file');

      // Fetch tiap file (parallel, max 20 concurrent)
      const BATCH = 20;
      const apps = [];
      for (let i = 0; i < jsonFiles.length; i += BATCH) {
        const batch = jsonFiles.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (file) => {
          try {
            const r = await fetch(file.download_url, { cf: { cacheTtl: CACHE_SECONDS } });
            if (!r.ok) return null;
            const versions = await r.json();
            const base = file.name.replace(/\.json$/, '');
            const sep = base.indexOf('_');
            const platform = base.slice(0, sep);
            const appId = base.slice(sep + 1);

            // Ambil app_title dari versi pertama yg ada
            let appTitle = appId;
            for (const v of (Array.isArray(versions) ? versions : [])) {
              if (v.app_title) { appTitle = v.app_title; break; }
            }

            return {
              platform,
              app_id: appId,
              app_title: appTitle,
              versions: Array.isArray(versions) ? versions : [],
            };
          } catch { return null; }
        }));
        apps.push(...results.filter(Boolean));
      }

      return json({ app_count: apps.length, apps });
    }

    return err('Endpoint tidak ditemukan', 404);
  } catch (e) {
    return err('Server error: ' + e.message, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function err(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
