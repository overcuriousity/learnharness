/** The dictation surface renders only with a Deepgram key, and nothing
 * contacts the token route (→ Deepgram) until the user starts dictating. */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { DictationBar, useDictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture(deepgramPresent: boolean) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = { present: deepgramPresent, calls: [] as string[] };
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "" },
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			state.calls.push(url);
			if (url === "/api/keys") return Response.json({ keys: [{ id: "DEEPGRAM_API_KEY", present: state.present }] });
			if (url === "/api/settings") return Response.json({ settings: { version: 1 } });
			return Response.json({}, { status: 404 });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	function Harness() {
		const dictation = useDictation({ append: () => {} });
		return <DictationBar dictation={dictation} />;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	// The presence cache is module-level: re-read for this fixture's server.
	await act(async () => { notifySettingsSaved("keys"); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return { state, host: document.getElementById("root")! };
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("no Deepgram key: no Dictate button, and the shortcut does nothing", async () => {
	const f = await fixture(false);
	assert.equal(f.host.querySelector("[data-testid='dictation-toggle']"), null);
	await act(async () => { window.dispatchEvent(new CustomEvent("lh:kbd-toggle-dictation")); });
	assert.ok(!f.state.calls.includes("/api/stt/token"));
});

test("with a Deepgram key the button renders, and mounting never pre-mints a token", async () => {
	const f = await fixture(true);
	assert.ok(f.host.querySelector("[data-testid='dictation-toggle']"));
	assert.ok(f.state.calls.includes("/api/keys"));
	assert.ok(!f.state.calls.includes("/api/stt/token"), "no Deepgram token until the user dictates");
});

test("adding the key in Settings shows the button without a reload", async () => {
	const f = await fixture(false);
	assert.equal(f.host.querySelector("[data-testid='dictation-toggle']"), null);
	f.state.present = true;
	await act(async () => { notifySettingsSaved("keys"); });
	assert.ok(f.host.querySelector("[data-testid='dictation-toggle']"));
});
