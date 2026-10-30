/**
 * LH_SERVER_MODE=1 (server fork): the app runs on a remote server behind a
 * reverse proxy. Two providers cannot work there and are switched off:
 *  - Claude Code would spawn the local `claude` CLI with the SERVICE
 *    user's credentials — hidden from the catalog and settings, routes 404.
 *  - ChatGPT sign-in's OAuth callback listens on the server's own
 *    127.0.0.1, unreachable from a remote browser — hidden with a one-line
 *    explanation. Copilot and Grok use device codes and stay available.
 * Read live from the environment (server-only callers; in a browser bundle
 * process.env has no such key, so it reads false).
 */
export function serverMode(env: Record<string, string | undefined> = process.env): boolean {
	return env.LH_SERVER_MODE === "1";
}

/** The one-line explanation shown where the ChatGPT connection would be. */
export const CHATGPT_SERVER_MODE_NOTICE =
	"ChatGPT sign-in isn't available on a server deployment: its sign-in callback only listens on the server itself.";
