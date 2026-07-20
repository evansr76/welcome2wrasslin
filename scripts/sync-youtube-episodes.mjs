/**
 * Sync latest full-length YouTube videos into episodes.json.
 * Filters out Shorts. Run manually or via GitHub Actions.
 *
 * Usage: node scripts/sync-youtube-episodes.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_FILE = join(ROOT, 'episodes.json');

const CHANNEL_ID = 'UCGINH-DM9Psuj0aTRsFhJZg';
const CHANNEL_URL = 'https://www.youtube.com/@Welcome2wrasslin';
const FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const LIMIT = 3;

function decodeXml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function parseFeed(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRe.exec(xml)) !== null) {
    const block = match[1];
    const videoId = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const titleRaw = (block.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    const href = (block.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || '';
    if (!videoId) continue;
    entries.push({
      videoId,
      title: decodeXml(titleRaw).trim(),
      published,
      url: href || `https://www.youtube.com/watch?v=${videoId}`,
      isShort: /\/shorts\//i.test(href),
    });
  }
  return entries;
}

function stableStringify(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

async function main() {
  console.log(`Fetching feed for channel ${CHANNEL_ID}…`);
  const res = await fetch(FEED_URL, {
    headers: { 'User-Agent': 'welcome2wrasslin-sync/1.0' },
  });
  if (!res.ok) {
    throw new Error(`YouTube feed request failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const all = parseFeed(xml);
  const full = all.filter((e) => !e.isShort).slice(0, LIMIT);

  if (full.length === 0) {
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

  let previous = null;
  try {
    previous = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch {
    // first run
  }

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

  console.log(changed ? 'CHANGE_DETECTED=true' : 'CHANGE_DETECTED=false');

  // GitHub Actions step output
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, { flag: 'a' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
