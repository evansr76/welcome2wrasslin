/**
 * Sync latest full-length YouTube videos into episodes.json.
 * Filters out Shorts. Run manually or via GitHub Actions.
 *
 * Usage: node scripts/sync-youtube-episodes.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_FILE = join(ROOT, 'episodes.json');

const CHANNEL_ID = 'UCGINH-DM9Psuj0aTRsFhJZg';
const CHANNEL_URL = 'https://www.youtube.com/@Welcome2wrasslin';
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const LIMIT = 3;
const FETCH_ATTEMPTS = 3;
const FETCH_BACKOFF_MS = [1000, 3000, 8000];

function decodeXml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

/** Extract href from <link rel="alternate" …> regardless of attribute order. */
function alternateHref(block) {
  const linkTags = block.matchAll(/<link\b([^>]*)\/?>/gi);
  for (const tag of linkTags) {
    const attrs = tag[1] || '';
    if (!/\brel\s*=\s*["']alternate["']/i.test(attrs)) continue;
    const href = (attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (href) return href;
  }
  return '';
}

function parseFeed(xml) {
  if (!xml || !/<feed[\s>]/.test(xml) || !/<entry[\s>]/.test(xml)) {
    const preview = String(xml || '').slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(
      `Response does not look like a YouTube Atom feed (missing <feed>/<entry>). Preview: ${preview}`
    );
  }

  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRe.exec(xml)) !== null) {
    const block = match[1];
    const videoId = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const titleRaw = (block.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    const href = alternateHref(block);
    if (!videoId) continue;
    const title = decodeXml(titleRaw).trim();
    entries.push({
      videoId,
      title,
      published,
      url: href || `https://www.youtube.com/watch?v=${videoId}`,
      // YouTube RSS uses /shorts/ URLs for Shorts; also catch #shorts in titles
      isShort: /\/shorts\//i.test(href) || /#shorts\b/i.test(title),
    });
  }
  return entries;
}

function stableStringify(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function readPrevious() {
  try {
    return JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function setOutput(changed) {
  console.log(changed ? 'CHANGE_DETECTED=true' : 'CHANGE_DETECTED=false');
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, { flag: 'a' });
  }
}

async function fetchFeedXml() {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      console.log(`Fetching feed (attempt ${attempt}/${FETCH_ATTEMPTS})…`);
      const res = await fetch(FEED_URL, {
        headers: {
          'User-Agent': 'welcome2wrasslin-sync/1.0 (+https://github.com/evansr76/welcome2wrasslin)',
          Accept: 'application/atom+xml, application/xml, text/xml, */*',
        },
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new Error(`YouTube feed request failed: ${res.status} ${res.statusText}`);
      }
      const xml = await res.text();
      if (!xml || xml.length < 50) {
        throw new Error('YouTube feed response was empty or too short');
      }
      return xml;
    } catch (err) {
      lastErr = err;
      console.warn(`  attempt ${attempt} failed: ${err.message || err}`);
      if (attempt < FETCH_ATTEMPTS) {
        const wait = FETCH_BACKOFF_MS[attempt - 1] || 5000;
        console.warn(`  retrying in ${wait}ms…`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/**
 * Soft-exit: keep existing episodes.json and report no change.
 * Used for transient feed blips so hourly Actions don't stay red.
 */
function softExit(reason, previous) {
  console.warn(`SOFT_FAIL: ${reason}`);
  if (previous?.episodes?.length) {
    console.warn(
      `Keeping existing episodes.json (${previous.episodes.length} episode(s), updatedAt=${previous.updatedAt || 'unknown'})`
    );
  } else {
    console.warn('No previous episodes.json to fall back on.');
  }
  setOutput(false);
  process.exit(0);
}

async function main() {
  console.log(`Fetching feed for channel ${CHANNEL_ID}…`);
  const previous = readPrevious();
  const hasFallback = Boolean(previous?.episodes?.length);

  let xml;
  try {
    xml = await fetchFeedXml();
  } catch (err) {
    if (hasFallback) {
      softExit(`feed fetch failed after ${FETCH_ATTEMPTS} attempts: ${err.message || err}`, previous);
    }
    throw err;
  }

  let all;
  try {
    all = parseFeed(xml);
  } catch (err) {
    if (hasFallback) {
      softExit(`feed parse failed: ${err.message || err}`, previous);
    }
    throw err;
  }

  const fullAll = all.filter((e) => !e.isShort);
  const shorts = all.length - fullAll.length;
  const full = fullAll.slice(0, LIMIT);

  console.log(
    `Parsed ${all.length} feed entr(y/ies): ${fullAll.length} full-length, ${shorts} short(s); keeping top ${full.length}`
  );

  if (full.length === 0) {
    if (hasFallback) {
      softExit(
        'No full-length videos in feed (only Shorts or empty). YouTube RSS only returns ~15 latest items.',
        previous
      );
    }
    throw new Error('No full-length videos found in feed (only Shorts or empty feed).');
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    channelId: CHANNEL_ID,
    channelUrl: CHANNEL_URL,
    episodes: full.map(({ videoId, title, published, url }) => ({
      videoId,
      title,
      published,
      url,
    })),
  };

  const episodeSignature = (data) =>
    JSON.stringify(
      (data?.episodes || []).map((e) => ({
        videoId: e.videoId,
        title: e.title,
        published: e.published,
      }))
    );

  const changed = episodeSignature(previous) !== episodeSignature(payload);

  if (changed) {
    writeFileSync(OUT_FILE, stableStringify(payload), 'utf8');
    console.log(`Updated episodes.json with ${payload.episodes.length} episode(s)`);
  } else {
    console.log('No episode changes — episodes.json left as-is');
  }

  payload.episodes.forEach((ep, i) => {
    console.log(`  ${i + 1}. ${ep.videoId} — ${ep.title}`);
  });

  setOutput(changed);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
