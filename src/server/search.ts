/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20; SearXNG added by the server fork): the Tavily, Brave and
 * SearXNG adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when BOTH keys are present
 *    the preference order is Tavily → Brave); without a pin, whichever
 *    engine has a key is the engine.
 *  - An explicit choice does NOT silently fall back to the other engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import { isSearxngBaseUrl } from "../core/auth-keys.ts";
import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Per-request timeout (owner spec: 15 s). */
export const SEARXNG_TIMEOUT_MS = 15_000;

/** Parse a SearXNG base URL (shape rule shared with the key gate,
 *  core/auth-keys.ts isSearxngBaseUrl). Returns the base with no trailing
 *  slash, or null when invalid. */
export function parseSearxngBaseUrl(raw: string | undefined): string | null {
	const value = raw?.trim();
	if (!value || !isSearxngBaseUrl(value)) return null;
	return new URL(value).href.replace(/\/+$/, "");
}

/** SearXNG search API: GET {base}/search?q=…&format=json&pageno=1
 *  &categories=general&safesearch=0. JSON output must be enabled on the
 *  instance (settings.yml search.formats: [html, json]) — otherwise it
 *  answers 403. The API has no result-count parameter: the first `count`
 *  entries of results[] are kept. */
export function searxngProvider(baseUrl: string, authHeader?: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "searxng",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL(`${baseUrl}/search`);
			url.searchParams.set("q", query);
			url.searchParams.set("format", "json");
			url.searchParams.set("pageno", "1");
			url.searchParams.set("categories", "general");
			url.searchParams.set("safesearch", "0");
			const headers: Record<string, string> = { accept: "application/json" };
			if (authHeader) headers.authorization = authHeader;
			let resp: Response;
			try {
				resp = await fetchFn(url.toString(), { headers, signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS) });
			} catch (err) {
				if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
					throw new Error(`SearXNG did not answer within ${SEARXNG_TIMEOUT_MS / 1000} s`);
				}
				throw new Error(`SearXNG request failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (resp.status === 403) {
				throw new Error(
					"SearXNG answered 403 Forbidden: the instance must allow JSON output " +
					"(settings.yml: search.formats: [html, json]).",
				);
			}
			if (resp.status === 429) {
				throw new Error(
					"SearXNG answered 429 Too Many Requests: its limiter (bot detection) blocked this server. " +
					"Add the LearnHarness host to the limiter's pass list, or turn the limiter off for a private instance.",
				);
			}
			if (!resp.ok) {
				const text = await resp.text().catch(() => "");
				throw new Error(`SearXNG ${resp.status}: ${text.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.slice(0, count)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\s*\n\s*/g, " ").slice(0, 500),
				}));
		},
	};
}

/** The engines this build ships, in PREFERENCE order (several keyed, no
 *  explicit pin → the first live engine wins; owner decision 2026-09-20:
 *  Tavily first; server fork: SearXNG appended last). SearXNG's "key" is
 *  its base URL. */
const ENGINE_ORDER: ReadonlyArray<{ id: SearchEngineId; envVar: string }> = [
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
	{ id: "searxng", envVar: "SEARXNG_URL" },
];

/** The env var that makes an engine live (for the missing-key reason). */
function engineEnvVar(id: SearchEngineId): string {
	return ENGINE_ORDER.find((e) => e.id === id)!.envVar;
}

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. An invalid
 *  SEARXNG_URL counts as not keyed (never a guess). */
function engineKey(id: SearchEngineId): string | null {
	const value = keyValue(engineEnvVar(id));
	if (id === "searxng") return parseSearxngBaseUrl(value);
	return value ? value : null;
}

/** Every engine's live key, for resolveSearchEngineFor. */
function engineKeys(): Partial<Record<SearchEngineId, string | undefined>> {
	return Object.fromEntries(ENGINE_ORDER.map(({ id }) => [id, engineKey(id) ?? undefined]));
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed; absent pin → first
 *  keyed engine in preference order. Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
				reason: pinned === "searxng"
					? `search engine is set to "searxng" but SEARXNG_URL is missing or not a valid http(s) base URL`
					: `search engine is set to "${pinned}" but its API key is missing — set the ${engineEnvVar(pinned)} key`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of ENGINE_ORDER) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily or Brave search API key, or SEARXNG_URL",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, engineKeys());
	if (!resolved.available || !resolved.key) return null;
	if (resolved.engine === "searxng") return searxngProvider(resolved.key, keyValue("SEARXNG_AUTH_HEADER") || undefined);
	return resolved.engine === "tavily" ? tavilyProvider(resolved.key) : braveProvider(resolved.key);
}
