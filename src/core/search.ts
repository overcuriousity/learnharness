/**
 * The search-provider port. Search engines are pluggable behind ONE seam;
 * the server composes the live adapter (src/server/search.ts).
 *
 * Server fork: the only engine is SearXNG, configured through the
 * SEARXNG_URL key (+ optional SEARXNG_AUTH_HEADER). Nothing silently falls
 * back: no engine live = search is honestly unavailable (web_search says
 * so as a tool result).
 *
 * Pure types + protocol docs only (browser-safe, no node imports): the
 * adapters are server-side and arrive as injected dependencies — the
 * agent-layer tool depends on THIS port only.
 */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** The engine ids this build ships. */
export type SearchEngineId = "searxng";

/** A live search engine: an id (for status/labels) + one operation. The
 *  adapters own their wire protocol (fetch, timeouts, error mapping) —
 *  callers see only this. `search` throws on failure (adapters map HTTP
 *  errors to clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number): Promise<SearchHit[]>;
}

/** Why search is (un)available — the honest status the UI and the tool
 *  layer explain from. `engine` is the ACTIVE engine when live. */
export interface SearchStatus {
	available: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
}
