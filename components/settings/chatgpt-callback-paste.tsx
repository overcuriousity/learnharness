"use client";
/** Server fork: finish a ChatGPT sign-in from a remote browser. OpenAI sends
 *  the browser to the server's own 127.0.0.1 callback, which the browser
 *  cannot reach; the learner pastes that address and the server relays it
 *  (src/server/chatgpt-callback-relay.ts). Shown while a sign-in is pending. */
import { useState } from "react";
import { Button } from "@/components/ui/button";

export const CALLBACK_PASTE_HINT = "Signed in, but the browser shows a page that can't be reached? Paste that page's address here.";
const FAILED = "The sign-in could not be finished. Start it again with Connect.";

export function ChatGPTCallbackPaste({ disabled = false }: { disabled?: boolean }) {
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async () => {
		if (busy || !value.trim()) return;
		setBusy(true); setError(null);
		try {
			const response = await fetch("/api/subscriptions/chatgpt-callback", {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-learnharness-subscriptions": "1" },
				body: JSON.stringify({ url: value.trim() }),
			});
			const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
			if (response.ok && body.ok) setValue("");
			else setError(typeof body.error === "string" ? body.error : FAILED);
		} catch {
			setError(FAILED);
		} finally {
			setBusy(false);
		}
	};
	return <div className="mt-2 flex flex-col gap-1.5" data-testid="chatgpt-callback-paste">
		<p className="text-xs text-muted-foreground">{CALLBACK_PASTE_HINT}</p>
		<div className="flex items-center gap-2">
			<input
				type="url"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}
				placeholder="http://127.0.0.1:…/auth/callback?…"
				aria-label="Sign-in callback address"
				spellCheck={false}
				autoComplete="off"
				disabled={disabled || busy}
				className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
			/>
			<Button type="button" size="xs" variant="outline" data-testid="chatgpt-callback-submit" disabled={disabled || busy || !value.trim()} onClick={() => void submit()}>Finish sign-in</Button>
		</div>
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
	</div>;
}
