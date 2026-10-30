/** The paperclip renders only when the server reports a library folder. */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function mountWith(available: boolean) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const calls: string[] = [];
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "" }, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => { calls.push(url); return Response.json({ available }); },
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, d] of previous) {
			if (d) Object.defineProperty(globalThis, key, d);
			else delete globals[key];
		}
	};
	// Fresh module per scenario: the availability cache is module-level.
	const { LibraryUploadButton } = await import(`../components/library-upload-button.tsx?${available}`);
	const { createRoot } = await import("react-dom/client");
	const ref = { current: null };
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<LibraryUploadButton inputRef={ref} />); });
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return { host: document.getElementById("root")!, calls };
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("no library folder: no paperclip", async () => {
	const f = await mountWith(false);
	assert.deepEqual(f.calls, ["/api/library"]);
	assert.equal(f.host.querySelector("[data-testid='library-upload-button']"), null);
});

test("with a library folder the paperclip and its file input render", async () => {
	const f = await mountWith(true);
	assert.ok(f.host.querySelector("[data-testid='library-upload-button']"));
	assert.ok(f.host.querySelector("[data-testid='library-upload-input']"));
});
