/**
 * Cloudflare Pages Function — wildcard route handler
 *
 * GET /api/index          → data/reports/index.json
 * GET /api/report/:date   → data/reports/YYYY-MM-DD.json
 * GET /api/history        → semua data/history/*.json
 */

const GH = "https://api.github.com";
const CACHE = 300;

// Mapping app_id → nama app yang readable
// Di-update otomatis dari report JSON kalau tersedia,
// ini sebagai fallback untuk history yang belum punya app_title
const APP_NAME_MAP = {
  // iOS
  "1539402234": "Bank Jago / Jago Syariah",
  "1525477806": "SeaBank",
  "1550237185": "blu by BCA Digital",
  "1519178181": "neobank by BNC Digital",
  "1591223632": "Allo Bank",
  "1079340119": "Jenius",
  "1555414743": "Livin' by Mandiri",
  "1440241902": "myBCA",
  "1439730817": "BRImo BRI",
  "505917174":  "OCTO by CIMB Niaga",
  // Android
  "com.jago.digitalBanking":           "Bank Jago / Jago Syariah",
  "id.co.bankbkemobile.digitalbank":   "SeaBank",
  "com.bcadigital.blu":                "blu by BCA Digital",
  "com.bnc.finance":                   "neobank by BNC Digital",
  "com.alloapp.yump":                  "Allo Bank",
  "com.btpn.dc":                       "Jenius",
  "id.bmri.livin":                     "Livin' by Mandiri",
  "com.bca.mybca.omni.android":        "myBCA",
  "id.co.bri.brimo":                   "BRImo BRI",
  "id.co.cimbniaga.mobile.android":    "OCTO by CIMB Niaga",
};

export async function onRequest(context) {
  const { request, env } = context;
  const path = new URL(request.url).pathname.replace(/^\/api/, '') || '/';

  const { GITHUB_TOKEN: token, GITHUB_OWNER: owner, GITHUB_REPO: repo } = env;
  if (!token || !owner || !repo) {
    return errResp("Server belum dikonfigurasi.", 500);
  }

  const ghFetch = (p) => fetch(`${GH}/repos/${owner}/${repo}/contents/${p}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "competitor-dashboard",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  const decodeFile = async (r) => {
    const f = await r.json();
    const b64 = f.content.replace(/\n/g, '');
    const decoded = atob(b64);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  };

  try {
    // ── GET /api/index ──
    if (path === '/index') {
      const r = await ghFetch('data/reports/index.json');
      if (r.status === 404) return jsonResp([]);
      if (!r.ok) return errResp(`GitHub ${r.status}`, r.status);
      return jsonResp(await decodeFile(r));
    }

    // ── GET /api/report/YYYY-MM-DD ──
    const rm = path.match(/^\/report\/(\d{4}-\d{2}-\d{2})$/);
    if (rm) {
      const r = await ghFetch(`data/reports/${rm[1]}.json`);
      if (r.status === 404) return errResp('Laporan tidak ditemukan', 404);
      if (!r.ok) return errResp(`GitHub ${r.status}`, r.status);
      return jsonResp(await decodeFile(r));
    }

    // ── GET /api/history ──
    if (path === '/history') {
      const listR = await ghFetch('data/history');
      if (!listR.ok) return errResp(`GitHub ${listR.status}`, listR.status);
      const files = await listR.json();
      const jsonFiles = files.filter(f => f.name.endsWith('.json') && f.type === 'file');

      const BATCH = 10;
      const apps = [];

      for (let i = 0; i < jsonFiles.length; i += BATCH) {
        const batch = jsonFiles.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (file) => {
          try {
            const r = await fetch(file.download_url);
            if (!r.ok) return null;
            const versions = await r.json();
            if (!Array.isArray(versions) || versions.length === 0) return null;

            // Parse platform & app_id dari nama file
            const base = file.name.replace(/\.json$/, '');
            const sepIdx = base.indexOf('_');
            const platform = base.slice(0, sepIdx);
            const appId = base.slice(sepIdx + 1);

            // Cari app_title: prioritas dari mapping, fallback dari versi entry
            let appTitle = APP_NAME_MAP[appId] || null;

            if (!appTitle) {
              // Coba dari field app_title di dalam versi (kalau ada)
              for (let j = versions.length - 1; j >= 0; j--) {
                if (versions[j].app_title) { appTitle = versions[j].app_title; break; }
              }
            }

            if (!appTitle) appTitle = appId; // last resort

            return { platform, app_id: appId, app_title: appTitle, versions };
          } catch { return null; }
        }));

        apps.push(...results.filter(Boolean));
      }

      return jsonResp({ app_count: apps.length, apps });
    }

    return errResp('Endpoint tidak ditemukan', 404);
  } catch (e) {
    return errResp(`Server error: ${e.message}`, 500);
  }
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function errResp(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
