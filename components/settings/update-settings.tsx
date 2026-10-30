"use client";

import { SettingsRow } from "./controls.tsx";

export const APP_VERSION = process.env.LH_VERSION ?? "";
/** This fork's source. Deliberately NOT package.json homepage: that field is
 *  the app attribution pi-ai sends to model providers and stays upstream's. */
export const SOURCE_URL = "https://github.com/overcuriousity/learnharness";

/** Version information only — the server build has no updater. */
export function UpdateSettings({ version = APP_VERSION }: { version?: string }) {
	return (
		<SettingsRow
			label={`Version ${version || "unknown"}`}
			testid="row-version"
			hint={
				<a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="source-link">Source</a>
			}
		>
			{null}
		</SettingsRow>
	);
}
