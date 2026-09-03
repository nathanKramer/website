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
 */

const APP_ID = 2003100;

/** The page shows a top 10, so there's no reason to fetch or ship more. */
const TOP_N = 10;

/** Steam caps GetPlayerSummaries at 100 steamids per request. */
const SUMMARIES_CHUNK = 100;

/** Bound each upstream call so a hung Steam request can't eat the whole budget. */
const UPSTREAM_TIMEOUT_MS = 8000;

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

/**
 * ELeaderboardDisplayType. Only the two the game uses are mapped: point boards
 * are Numeric, Labyrinth stores survival time as milliseconds. The page formats
 * on this rather than hardcoding which board is which.
 */
function displayTypeName(raw: number): "numeric" | "milliseconds" | "seconds" {
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

type Entry = {
  rank: number;
  score: number;
  steamId: string;
  name: string | null;
  avatar: string | null;
  profileUrl: string | null;
};

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
 * `label` rather than the URL is what appears in errors, so a request that
 * authenticates via a query parameter can't leak it into a stack trace.
 */
async function fetchText(url: string, label: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { "User-Agent": "nathankramer.dev leaderboards" },
  });
  if (!response.ok) {
    throw new Error(`${label} responded ${response.status}`);
  }
  return response.text();
}

/** Lists the game's boards. This is the only call that must succeed. */
async function fetchBoardIndex(): Promise<BoardMeta[]> {
  const xml = await fetchText(
    `https://steamcommunity.com/stats/${APP_ID}/leaderboards/?xml=1`,
    "board index",
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
async function fetchEntries(board: BoardMeta): Promise<Entry[]> {
  const xml = await fetchText(
    `https://steamcommunity.com/stats/${APP_ID}/leaderboards/${board.lbid}/?xml=1&start=1&end=${TOP_N}`,
    `board ${board.name}`,
  );

  const entries: Entry[] = [];
  for (const block of blocks(xml, "entry")) {
    const steamId = tagText(block, "steamid");
    const score = tagNumber(block, "score");
    const rank = tagNumber(block, "rank");
    if (!steamId || score === null || rank === null) continue;
    entries.push({ rank, score, steamId, name: null, avatar: null, profileUrl: null });
  }
  return entries.sort((a, b) => a.rank - b.rank);
}

type Profile = { name: string; avatar: string; profileUrl: string };

/**
 * Resolves steamids to persona names and avatars. Players with private profiles
 * simply aren't returned by Steam, and neither is anything if the key is
 * missing — both cases leave those rows unresolved rather than failing the
 * request, so the board still renders (the page supplies the fallback label).
 */
async function fetchProfiles(steamIds: string[]): Promise<Map<string, Profile>> {
  const profiles = new Map<string, Profile>();
  const key = process.env.STEAM_WEB_API_KEY;
  if (!key || steamIds.length === 0) return profiles;

  for (let i = 0; i < steamIds.length; i += SUMMARIES_CHUNK) {
    const chunk = steamIds.slice(i, i + SUMMARIES_CHUNK);
    const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
    url.searchParams.set("key", key);
    url.searchParams.set("steamids", chunk.join(","));

    try {
      const payload = JSON.parse(await fetchText(url.toString(), "player summaries"));
      for (const player of payload?.response?.players ?? []) {
        if (!player?.steamid) continue;
        profiles.set(player.steamid, {
          name: player.personaname ?? "",
          avatar: player.avatarmedium ?? player.avatar ?? "",
          profileUrl: player.profileurl ?? "",
        });
      }
    } catch (error) {
      // Names are a nicety; the scores are the point. Log and carry on.
      console.warn("leaderboards: player summaries lookup failed:", redact(error));
    }
  }

  return profiles;
}

export default async (_req: Request, _context: Context) => {
  let boards: BoardMeta[];
  try {
    boards = await fetchBoardIndex();
  } catch (error) {
    console.error("leaderboards: board index unavailable:", redact(error));
    return Response.json({ error: "Steam leaderboards are unavailable right now." }, { status: 502 });
  }

  const settled = await Promise.all(
    boards.map(async (board) => {
      try {
        return { board, entries: await fetchEntries(board) };
      } catch (error) {
        // One flaky board shouldn't blank the whole page.
        console.warn(`leaderboards: board ${board.name} unavailable:`, redact(error));
        return { board, entries: [] as Entry[] };
      }
    }),
  );

  const profiles = await fetchProfiles([
    ...new Set(settled.flatMap(({ entries }) => entries.map((e) => e.steamId))),
  ]);

  const body = {
    appId: APP_ID,
    updatedAt: new Date().toISOString(),
    boards: settled.map(({ board, entries }) => ({
      id: board.lbid,
      name: board.name,
      title: BOARD_TITLES[board.name] ?? board.feedTitle,
      displayType: displayTypeName(board.displayType),
      totalEntries: board.totalEntries,
      // Deliberately not spreading `entry`: the steamid and profile URL are
      // used to look a player up and then dropped, so the only identity that
      // leaves this function is the display name and avatar the board shows.
      entries: entries.map((entry) => {
        const profile = profiles.get(entry.steamId);
        return {
          rank: entry.rank,
          score: entry.score,
          name: profile?.name || null,
          avatar: profile?.avatar || null,
        };
      }),
    })),
  };

  return Response.json(body, {
    headers: {
      // The browser holds it briefly; Netlify's CDN absorbs the rest, so Steam
      // sees a handful of requests an hour no matter how busy the page is.
      // `stale-while-revalidate` means a Steam outage serves yesterday's board
      // instead of an error.
      "Cache-Control": "public, max-age=60",
      "Netlify-CDN-Cache-Control": "public, max-age=300, stale-while-revalidate=3600, durable",
    },
  });
};

export const config: Config = {
  path: "/api/leaderboards",
};
