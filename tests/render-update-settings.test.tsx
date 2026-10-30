/** Settings → General: version + this fork's source link, no updater. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SOURCE_URL, UpdateSettings } from "../components/settings/update-settings.tsx";

describe("General settings (server fork)", () => {
	it("shows the version and links the fork's source, with no update controls", () => {
		const html = renderToStaticMarkup(<UpdateSettings version="0.4.0" />);
		assert.match(html, /Version 0\.4\.0/);
		assert.match(html, new RegExp(`href="${SOURCE_URL}"`));
		assert.equal(SOURCE_URL, "https://github.com/overcuriousity/learnharness");
		assert.doesNotMatch(html, /update-check|update-restart|row-auto-update|releases\/tag/);
	});
});
