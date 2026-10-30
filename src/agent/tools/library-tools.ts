import type { AgentTool } from "@earendil-works/pi-agent-core";
import { findTool } from "./find.ts";
import { libraryRoot } from "./fs-shared.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";

/** The learner-file tools, registered only while LH_LIBRARY_DIR is usable
 *  (fs-shared.ts — unset or misconfigured = no file tools at all). The pdf
 *  job reads library files too, so callers gate it on the same signal. */
export function libraryFileTools(): Record<string, AgentTool<any>> {
	return libraryAvailable() ? { read: readTool, ls: lsTool, find: findTool, grep: grepTool } : {};
}

export function libraryAvailable(): boolean {
	return libraryRoot() !== null;
}
