/**
 * egress-audit.mjs — log every outbound connection a Node process makes.
 *
 * Preload (every Node process that inherits NODE_OPTIONS is covered,
 * including the server's child processes and worker threads):
 *
 *   LH_EGRESS_LOG=/tmp/egress.jsonl \
 *   NODE_OPTIONS="--import=$PWD/scripts/egress-audit.mjs" \
 *   node .next/standalone/server.js
 *
 * Summarize a log (loopback and local sockets are listed separately):
 *
 *   node scripts/egress-audit.mjs summarize /tmp/egress.jsonl
 *
 * What is recorded, one JSON line each: net/tls socket connects (this is
 * where http, https, undici fetch and WebSockets all end up), DNS lookups,
 * http(s).request targets and fetch() URLs. Only destinations, never
 * headers or bodies. Non-Node processes (e.g. a Chrome launched for demo
 * verification) are outside this preload's reach.
 */
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

// Patch the CommonJS module objects (what every require() and the
// built-in clients share); ESM namespace objects are read-only.
const require = createRequire(import.meta.url);
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const workerThreads = require("node:worker_threads");

const LOG = process.env.LH_EGRESS_LOG || "egress-audit.jsonl";

const { isMainThread, threadId } = workerThreads;

function record(kind, fields) {
	const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, thread: isMainThread ? 0 : threadId, kind, ...fields });
	try {
		fs.appendFileSync(LOG, `${line}\n`);
	} catch {
		/* auditing must never break the audited process */
	}
}

function connectTarget(args) {
	const [first, second] = Array.isArray(args[0]) ? args[0] : args;
	if (first && typeof first === "object") {
		if (first.path) return { path: String(first.path) };
		return { host: first.host ?? first.hostname ?? "localhost", port: first.port ?? null };
	}
	if (typeof first === "string" && Number.isNaN(Number(first))) return { path: first };
	return { host: typeof second === "string" ? second : "localhost", port: first ?? null };
}

function urlTarget(input) {
	try {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input?.url);
		return { url: `${url.protocol}//${url.host}${url.pathname}` };
	} catch {
		return { url: String(input).slice(0, 200) };
	}
}

function install() {
	const connect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function (...args) {
		record("connect", connectTarget(args));
		return connect.apply(this, args);
	};

	const lookup = dns.lookup;
	dns.lookup = function (hostname, ...rest) {
		record("dns", { host: hostname });
		return lookup.call(this, hostname, ...rest);
	};
	const lookupPromise = dns.promises.lookup;
	dns.promises.lookup = function (hostname, ...rest) {
		record("dns", { host: hostname });
		return lookupPromise.call(this, hostname, ...rest);
	};

	for (const [name, mod] of [["http", http], ["https", https]]) {
		for (const method of ["request", "get"]) {
			const original = mod[method];
			mod[method] = function (input, ...rest) {
				const options = typeof input === "string" || input instanceof URL ? urlTarget(input) : {
					url: `${name}://${input?.hostname ?? input?.host ?? "localhost"}${input?.port ? `:${input.port}` : ""}${input?.path ?? "/"}`,
				};
				record(name, options);
				return original.call(this, input, ...rest);
			};
		}
	}

	if (typeof globalThis.fetch === "function") {
		const fetch = globalThis.fetch;
		globalThis.fetch = function (input, init) {
			record("fetch", urlTarget(input));
			return fetch.call(this, input, init);
		};
	}
	// Worker threads do not re-apply NODE_OPTIONS preloads: pass this file
	// to every new worker explicitly.
	const Worker = workerThreads.Worker;
	const self = `--import=${import.meta.url}`;
	workerThreads.Worker = class extends Worker {
		constructor(filename, options = {}) {
			const execArgv = options.execArgv ?? process.execArgv;
			super(filename, { ...options, execArgv: execArgv.includes(self) ? execArgv : [...execArgv, self] });
		}
	};
	// Make ESM named imports (`import { request } from "node:https"`) see
	// the patched functions too.
	syncBuiltinESMExports();
	record("start", { argv: process.argv.slice(1, 3) });
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);

function isLocal(entry) {
	if (entry.path) return true;
	let host = entry.host;
	if (!host && entry.url) {
		try { host = new URL(entry.url).hostname; } catch { return false; }
	}
	if (!host) return true;
	host = String(host).replace(/^\[|\]$/g, "");
	return LOCAL_HOSTS.has(host) || /^127\./.test(host) || /^::ffff:127\./.test(host);
}

function summarize(file) {
	const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const external = new Map();
	const local = new Map();
	const pids = new Set();
	for (const entry of lines) {
		pids.add(entry.pid);
		if (entry.kind === "start") continue;
		const key = entry.kind === "connect" || entry.kind === "dns"
			? `${entry.kind} ${entry.path ?? `${entry.host}${entry.port ? `:${entry.port}` : ""}`}`
			: `${entry.kind} ${entry.url}`;
		const bucket = isLocal(entry) ? local : external;
		bucket.set(key, (bucket.get(key) ?? 0) + 1);
	}
	const span = lines.length ? `${lines[0].ts} → ${lines.at(-1).ts}` : "empty log";
	console.log(`egress audit: ${file}`);
	console.log(`  ${lines.length} records from ${pids.size} process(es), ${span}`);
	console.log(`  EXTERNAL destinations: ${external.size}`);
	for (const [key, n] of [...external].sort()) console.log(`    ${String(n).padStart(5)}  ${key}`);
	console.log(`  local (loopback / sockets): ${local.size}`);
	for (const [key, n] of [...local].sort()) console.log(`    ${String(n).padStart(5)}  ${key}`);
	return external.size;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli && process.argv[2] === "summarize") {
	const file = process.argv[3] || LOG;
	process.exitCode = summarize(file) === 0 ? 0 : 1;
} else if (!isCli) {
	install();
}
