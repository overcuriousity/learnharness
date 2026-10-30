/** Phone-width sidebar (overlay drawer): starts closed, opening never
 *  rewrites the desktop preference; desktop keeps its stored default. */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function mount(phone: boolean, stored: string | null) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	const storage = new Map<string, string>(stored === null ? [] : [["lh:sidebar-open", stored]]);
	const localStorage = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => { storage.set(k, v); },
		removeItem: (k: string) => { storage.delete(k); },
	};
	Object.assign(win, {
		matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
		localStorage,
	});
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		React, window: win, document: doc, localStorage, navigator: { userAgent: "", platform: "" },
		HTMLElement: win.HTMLElement, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async () => Response.json({}),
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { SidebarProvider, useSidebar } = await import("../components/sidebar.tsx");
	const seen: { current: ReturnType<typeof useSidebar> | null } = { current: null };
	function Probe() { seen.current = useSidebar(); return null; }
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	await act(async () => { root.render(<SidebarProvider><Probe /></SidebarProvider>); });
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, d] of previous) {
			if (d) Object.defineProperty(globalThis, name, d);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	return { sidebar: () => seen.current!, storage };
}

test("phone: the drawer starts closed even when the desktop preference is open", async () => {
	const f = await mount(true, "1");
	assert.equal(f.sidebar().mobile, true);
	assert.equal(f.sidebar().open, false);
});

test("phone: opening and closing the drawer never rewrites the stored preference", async () => {
	const f = await mount(true, null);
	await act(async () => { f.sidebar().toggle(); });
	assert.equal(f.sidebar().open, true);
	await act(async () => { f.sidebar().close(); });
	assert.equal(f.sidebar().open, false);
	assert.equal(f.storage.has("lh:sidebar-open"), false);
});

test("desktop: first run opens the sidebar and a toggle persists the choice", async () => {
	const f = await mount(false, null);
	assert.equal(f.sidebar().mobile, false);
	assert.equal(f.sidebar().open, true);
	await act(async () => { f.sidebar().toggle(); });
	assert.equal(f.storage.get("lh:sidebar-open"), "0");
});
