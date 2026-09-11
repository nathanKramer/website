import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

/**
 * Serves the Starship Kepler Steam leaderboards as JSON.
 *
 * Two Steam sources are stitched together here:
 *
 *   1. The public Steam Community XML feed, which lists the game's boards and
 *      their entries (steamid + score + rank) with no authentication at all.
 *      It sends no CORS headers, which is why the browser can't call it
 *      directly and this function exists.
 *   2. ISteamUser/GetPlayerSummaries, which turns those steamids into persona
 *      names and avatars. That one needs a Web API key, which must stay
 *      server-side — the other reason this function exists.
 *
 * Source 1 rate-limits by IP, and Netlify's egress addresses are shared with
 * every other site on the platform, so 429s arrive unpredictably and have
 * nothing to do with this site's traffic. Two things guard against that: the
 * CDN cache below keeps Steam down to a few dozen requests a day, and every
 * successful response is written to a blob so a 429 serves the last known
 * board rather than an error.
 */

const APP_ID = 2003100;

/** The page shows a top 10, so there's no reason to fetch or ship more. */
const TOP_N = 10;

/** Steam caps GetPlayerSummaries at 100 steamids per request. */
const SUMMARIES_CHUNK = 100;

/**
 * Netlify kills a synchronous function at 10s. Stopping short of that leaves
 * room to fall back to the snapshot and still answer, rather than being cut off
 * mid-retry and handing the CDN a platform 502.
 */
const BUDGET_MS = 8000;

/** Ceiling for any one upstream call; the remaining budget can shorten it. */
const UPSTREAM_TIMEOUT_MS = 3500;

/** Backoff bounds for the single retry a rate-limited call gets. */
const RETRY_DELAY_MS = 600;
const MAX_RETRY_DELAY_MS = 2000;

/** Gap between community-feed calls, so one cache miss isn't a burst at Steam. */
const REQUEST_SPACING_MS = 150;

const SNAPSHOT_STORE = "starship-kepler";
const SNAPSHOT_KEY = "leaderboards";

/**
 * Display order and labels for the boards, keyed by the Steam API name defined
 * in the game's `allBoards`. The feed reports its own `display_name` ("Free Play
 * Leaderboard"), but these match what the game's own leaderboard screen shows.
 * Boards not listed here still render, at the end, under their feed name.
 */
const BOARD_TITLES: Record<string, string> = {
  free_play_high_score: "Free Play",
  quick_play_high_score: "Quick Play",
  labyrinth_high_score: "Labyrinth",
};
const BOARD_ORDER = Object.keys(BOARD_TITLES);

type DisplayType = "numeric" | "milliseconds" | "seconds";

/**
 * ELeaderboardDisplayType. Only the two the game uses are mapped: point boards
 * are Numeric, Labyrinth stores survival time as milliseconds. The page formats
 * on this rather than hardcoding which board is which.
 */
function displayTypeName(raw: number): DisplayType {
  switch (raw) {
    case 2:
      return "seconds";
    case 3:
      return "milliseconds";
    default:
      return "numeric";
  }
}

type BoardMeta = {
  lbid: string;
  name: string;
  feedTitle: string;
  displayType: number;
  totalEntries: number;
};

type Entry = { rank: number; score: number; steamId: string };

type Profile = { name: string; avatar: string };

/**
 * What gets persisted between invocations. It is the response body plus the
 * steamids, which stay here: the blob is server-side only, and keeping the ids
 * is what lets a later run reuse a name it already resolved.
 */
type SnapshotBoard = {
  id: string;
  name: string;
  title: string;
  displayType: DisplayType;
  totalEntries: number;
  entries: Entry[];
};

type Snapshot = {
  fetchedAt: string;
  boards: SnapshotBoard[];
  profiles: Record<string, Profile>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Valve's feed is flat, machine-generated XML with no attributes and no nesting
 * ambiguity, so these targeted extractors are sufficient and keep the function
 * bundle dependency-free. They are deliberately narrow: anything that doesn't
 * match the expected shape yields null and is skipped by the caller.
 */
function tagText(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, "s"));
  return match ? match[1] : null;
}

function tagNumber(xml: string, tag: string): number | null {
  const text = tagText(xml, tag);
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, "gs"))].map((m) => m[1]);
}

/**
 * Scrubs the API key out of anything on its way to a log line. The profiles
 * request carries the key as a query parameter, so an upstream error that
 * echoes the URL would otherwise put it in Netlify's function logs.
 */
function redact(value: unknown): string {
  const key = process.env.STEAM_WEB_API_KEY;
  const text = value instanceof Error ? value.message : String(value);
  return key ? text.replaceAll(key, "[redacted]") : text;
}

/**
 * Honours `Retry-After` when Steam sends a sane one, otherwise backs off on its
 * own. Capped, because anything longer than this is better spent answering from
 * the snapshot than sitting on a held-open connection.
 */
function retryDelay(response: Response, attempt: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  const advised = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  return Math.min(Math.max(advised, RETRY_DELAY_MS * (attempt + 1)), MAX_RETRY_DELAY_MS);
}

/**
 * `label` rather than the URL is what appears in errors, so a request that
 * authenticates via a query parameter can't leak it into a stack trace.
 *
 * Rate limits and upstream 5xxs get one retry, and only if the deadline can
 * still absorb the wait. Every other failure throws immediately — the caller
 * has a snapshot to fall back on, which beats spending the budget on a request
 * that isn't going to start working.
 */
async function fetchText(url: string, label: string, deadline: number): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const budget = Math.min(UPSTREAM_TIMEOUT_MS, deadline - Date.now());
    if (budget <= 0) throw new Error(`${label} skipped: out of time`);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(budget),
      headers: { "User-Agent": "nathankramer.dev leaderboards" },
    });
    if (response.ok) return response.text();

    const retriable = response.status === 429 || response.status >= 500;
    const wait = retryDelay(response, attempt);
    if (!retriable || attempt >= 1 || wait >= deadline - Date.now()) {
      throw new Error(`${label} responded ${response.status}`);
    }
    await sleep(wait);
  }
}

/** Lists the game's boards. This is the only call with no per-board fallback. */
async function fetchBoardIndex(deadline: number): Promise<BoardMeta[]> {
  const xml = await fetchText(
    `https://steamcommunity.com/stats/${APP_ID}/leaderboards/?xml=1`,
    "board index",
    deadline,
  );

  const boards: BoardMeta[] = [];
  for (const block of blocks(xml, "leaderboard")) {
    const lbid = tagText(block, "lbid");
    const name = tagText(block, "name");
    if (!lbid || !name) continue;
    boards.push({
      lbid,
      name,
      feedTitle: tagText(block, "display_name") ?? name,
      displayType: tagNumber(block, "displaytype") ?? 1,
      totalEntries: tagNumber(block, "entries") ?? 0,
    });
  }

  // Game order first, then anything new that shows up in the feed.
  return boards.sort((a, b) => {
    const ai = BOARD_ORDER.indexOf(a.name);
    const bi = BOARD_ORDER.indexOf(b.name);
    return (ai === -1 ? BOARD_ORDER.length : ai) - (bi === -1 ? BOARD_ORDER.length : bi);
  });
}

/**
 * Pulls one board's top entries. A nonexistent board id still answers 200 here,
 * so an empty parse — not the status code — is what signals "nothing to show".
 */
async function fetchEntries(board: BoardMeta, deadline: number): Promise<Entry[]> {
  const xml = await fetchText(
    `https://steamcommunity.com/stats/${APP_ID}/leaderboards/${board.lbid}/?xml=1&start=1&end=${TOP_N}`,
    `board ${board.name}`,
    deadline,
  );

  const entries: Entry[] = [];
  for (const block of blocks(xml, "entry")) {
    const steamId = tagText(block, "steamid");
    const score = tagNumber(block, "score");
    const rank = tagNumber(block, "rank");
    if (!steamId || score === null || rank === null) continue;
    entries.push({ rank, score, steamId });
  }
  return entries.sort((a, b) => a.rank - b.rank);
}

/**
 * Resolves steamids to persona names and avatars. Players with private profiles
 * simply aren't returned by Steam, and neither is anything if the key is
 * missing — both cases leave those rows unresolved rather than failing the
 * request, so the board still renders (the page supplies the fallback label).
 */
async function fetchProfiles(steamIds: string[], deadline: number): Promise<Record<string, Profile>> {
  const profiles: Record<string, Profile> = {};
  const key = process.env.STEAM_WEB_API_KEY;
  if (!key || steamIds.length === 0) return profiles;

  for (let i = 0; i < steamIds.length; i += SUMMARIES_CHUNK) {
    const chunk = steamIds.slice(i, i + SUMMARIES_CHUNK);
    const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
    url.searchParams.set("key", key);
    url.searchParams.set("steamids", chunk.join(","));

    try {
      const payload = JSON.parse(await fetchText(url.toString(), "player summaries", deadline));
      for (const player of payload?.response?.players ?? []) {
        if (!player?.steamid) continue;
        profiles[player.steamid] = {
          name: player.personaname ?? "",
          avatar: player.avatarmedium ?? player.avatar ?? "",
        };
      }
    } catch (error) {
      // Names are a nicety; the scores are the point. Log and carry on — the
      // caller has last run's names to fall back on.
      console.warn("leaderboards: player summaries lookup failed:", redact(error));
    }
  }

  return profiles;
}

/** Null whenever blobs aren't configured, which is the case under `astro dev`. */
function openStore() {
  try {
    return getStore(SNAPSHOT_STORE);
  } catch (error) {
    console.warn("leaderboards: blob store unavailable:", redact(error));
    return null;
  }
}

async function readSnapshot(store: ReturnType<typeof openStore>): Promise<Snapshot | null> {
  if (!store) return null;
  try {
    const data = (await store.get(SNAPSHOT_KEY, { type: "json" })) as Snapshot | null;
    // Shape check rather than trust: a snapshot written by an older version of
    // this function shouldn't be able to crash the current one.
    if (!data || typeof data.fetchedAt !== "string" || !Array.isArray(data.boards)) return null;
    return { fetchedAt: data.fetchedAt, boards: data.boards, profiles: data.profiles ?? {} };
  } catch (error) {
    console.warn("leaderboards: snapshot read failed:", redact(error));
    return null;
  }
}

async function writeSnapshot(store: ReturnType<typeof openStore>, snapshot: Snapshot) {
  if (!store) return;
  try {
    await store.setJSON(SNAPSHOT_KEY, snapshot);
  } catch (error) {
    // The response is already good; losing the write only costs the next run
    // its fallback.
    console.warn("leaderboards: snapshot write failed:", redact(error));
  }
}

/**
 * The one place a snapshot becomes a response, so the steamids can't reach the
 * page by accident: the id is used to look a player up and then dropped, and
 * the only identity that leaves this function is the display name and avatar
 * the board shows.
 */
function responseBody(snapshot: Snapshot) {
  return {
    appId: APP_ID,
    updatedAt: snapshot.fetchedAt,
    boards: snapshot.boards.map((board) => ({
      id: board.id,
      name: board.name,
      title: board.title,
      displayType: board.displayType,
      totalEntries: board.totalEntries,
      entries: board.entries.map((entry) => {
        const profile = snapshot.profiles[entry.steamId];
        return {
          rank: entry.rank,
          score: entry.score,
          name: profile?.name || null,
          avatar: profile?.avatar || null,
        };
      }),
    })),
  };
}

function serve(snapshot: Snapshot) {
  return Response.json(responseBody(snapshot), {
    headers: {
      // The browser holds it briefly; Netlify's CDN absorbs the rest, so Steam
      // sees a few dozen requests a day no matter how busy the page is. The
      // long `stale-while-revalidate` window is what keeps a rate-limited
      // refresh invisible: the previous board keeps being served while the
      // retry happens out of band. `durable` means one refresh covers every
      // edge node rather than one per region.
      "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=1800, stale-while-revalidate=86400",
    },
  });
}

/** Only reachable before the first ever success, so there's nothing to serve. */
function unavailable() {
  return Response.json(
    { error: "Steam leaderboards are unavailable right now." },
    {
      status: 502,
      headers: { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": "no-store" },
    },
  );
}

export default async (_req: Request, _context: Context) => {
  const deadline = Date.now() + BUDGET_MS;
  const store = openStore();
  const previous = await readSnapshot(store);

  let boards: BoardMeta[];
  try {
    boards = await fetchBoardIndex(deadline);
  } catch (error) {
    console.error("leaderboards: board index unavailable:", redact(error));
    if (!previous) return unavailable();
    return serve(previous);
  }

  // Serially, with a gap: the boards are fetched on a cache miss, and three
  // simultaneous hits from one of Netlify's shared egress IPs is exactly the
  // shape that earns a 429.
  const collected: SnapshotBoard[] = [];
  let anyFresh = false;
  for (const board of boards) {
    if (collected.length) await sleep(REQUEST_SPACING_MS);

    const fallback = previous?.boards.find((b) => b.id === board.lbid);
    let entries: Entry[];
    try {
      entries = await fetchEntries(board, deadline);
      anyFresh = true;
    } catch (error) {
      // One flaky board shouldn't blank the whole page.
      console.warn(`leaderboards: board ${board.name} unavailable:`, redact(error));
      entries = fallback?.entries ?? [];
    }

    // The index says how many entries the board holds, so parsing none out of a
    // board that has some means a truncated or throttled feed body rather than
    // an empty board. Keep what was there instead of publishing an empty one.
    if (entries.length === 0 && board.totalEntries > 0 && fallback?.entries.length) {
      entries = fallback.entries;
    }

    collected.push({
      id: board.lbid,
      name: board.name,
      title: BOARD_TITLES[board.name] ?? board.feedTitle,
      displayType: displayTypeName(board.displayType),
      totalEntries: board.totalEntries,
      entries,
    });
  }

  const steamIds = [...new Set(collected.flatMap((board) => board.entries.map((e) => e.steamId)))];

  // Seeded with what was already known and then overwritten by anything the
  // summaries call returns, so a failed lookup shows last run's names instead
  // of a board full of "Anonymous Pilot". Keying off the current ids is also
  // what prunes players who have dropped off the boards.
  const profiles: Record<string, Profile> = {};
  for (const steamId of steamIds) {
    const known = previous?.profiles[steamId];
    if (known) profiles[steamId] = known;
  }
  Object.assign(profiles, await fetchProfiles(steamIds, deadline));

  const snapshot: Snapshot = {
    // Don't claim freshness the scores don't have: if every board came from the
    // snapshot, the page should still say how old these numbers really are.
    fetchedAt: anyFresh || !previous ? new Date().toISOString() : previous.fetchedAt,
    boards: collected,
    profiles,
  };

  if (anyFresh) await writeSnapshot(store, snapshot);

  return serve(snapshot);
};

export const config: Config = {
  path: "/api/leaderboards",
};
