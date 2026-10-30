/**
 * The search engine's server composition: the SearXNG adapter behind the
 * core port (core/search.ts) + the live-engine resolution the settings UI
 * and the agent-layer tool both read.
 *
 * Server fork (replaces the Tavily + Brave wave of 2026-09-20):
 *  - ONE engine, SearXNG. It is live iff SEARXNG_URL holds a valid http(s)
 *    base URL (auth store or env — env wins, via server/keys.ts keyValue).
 *  - No silent fallback: no URL = search honestly unavailable.
 *  - SEARXNG_AUTH_HEADER (optional) is the full Authorization header value
 *    for instances behind basic auth. It is a secret: never logged, never
 *    returned to the browser (the key inventory redacts it fully).
 *
 * The adapter takes an injected fetch so tests never touch the network.
 */

import { isSearxngBaseUrl } from "../core/auth-keys.ts";
import type { SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";

/** The wire-callable shape the adapter closes over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

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

/** Resolve the search state PURELY from the configured URL (testable).
 *  Never throws; `baseUrl` is null whenever search is unavailable. */
export function resolveSearchEngineFor(rawUrl: string | undefined): SearchStatus & { baseUrl: string | null } {
	if (!rawUrl) {
		return { available: false, engine: null, reason: "no search engine configured — set SEARXNG_URL", baseUrl: null };
	}
	const baseUrl = parseSearxngBaseUrl(rawUrl);
	if (!baseUrl) {
		return {
			available: false,
			engine: null,
			reason: "SEARXNG_URL is not a valid http(s) base URL (no credentials, query or fragment)",
			baseUrl: null,
		};
	}
	return { available: true, engine: "searxng", reason: "search engine: SearXNG", baseUrl };
}

/** The live search state (the honest availability signal), read fresh each
 *  call so a URL saved mid-session takes effect without a restart. */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(keyValue("SEARXNG_URL"));
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's status signal). */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call. */
export function searchProvider(): SearchProvider | null {
	const { baseUrl } = resolveSearchEngineFor(keyValue("SEARXNG_URL"));
	if (!baseUrl) return null;
	return searxngProvider(baseUrl, keyValue("SEARXNG_AUTH_HEADER") || undefined);
}
