/**
 * Live PM2 Logs → Discord Webhook
 *
 * - Starts `pm2 logs` as a streaming process
 * - Listens live to stdout / stderr
 * - Sends every log line immediately to Discord
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const WEBHOOK_URL = "https://discord.com/api/webhooks/1461637805447839794/PO1fjBjqUcFxlK4Zkq2i5ZfGTZ0Bc15L6yfZuSva1xJRTIrB4yojRI8m6w05dXygIkqF";
const APP_NAME = "all"; // Change to your PM2 app name or 'all' for all apps
const DELETE_AFTER_SECONDS = 20;
const DELETE_AFTER_MS = Math.max(0, DELETE_AFTER_SECONDS) * 1000;

if (!WEBHOOK_URL) {
    throw new Error("[ERROR] Missing DISCORD_WEBHOOK_URL");
}

// Find pm2 executable (local ./node_modules/.bin, or system PATH)
function findPm2Sync() {
    const localBin = path.join(
        process.cwd(),
        "node_modules",
        ".bin",
        process.platform === "win32" ? "pm2.cmd" : "pm2"
    );
    if (fs.existsSync(localBin)) return localBin;

    const whichCmd = process.platform === "win32" ? "where" : "which";
    const res = spawnSync(whichCmd, ["pm2"], { encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
        let first = res.stdout.split(/\r?\n/)[0].trim();
        if (first) {
            if (fs.existsSync(first)) return first;
            if (process.platform === "win32") {
                const tryExts = [".cmd", ".exe", ".ps1"];
                for (const ext of tryExts) {
                    const withExt = first.endsWith(ext) ? first : first + ext;
                    if (fs.existsSync(withExt)) return withExt;
                }
                const dir = path.dirname(first);
                const base = path.basename(first);
                for (const ext of tryExts) {
                    const candidate = path.join(dir, base + ext);
                    if (fs.existsSync(candidate)) return candidate;
                }
            }
            return first;
        }
    }

    return null;
}

let triedNpx = false;
function spawnPm2Process(executable, args) {
    const opts = { stdio: ["ignore", "pipe", "pipe"] };
    if (process.platform === "win32") opts.shell = true;
    return spawn(executable, args, opts);
}

let pm2Executable = findPm2Sync();
let initialExecutable = pm2Executable || "npx";
if (!pm2Executable) {
    triedNpx = true;
}

// Ask pm2 to not print previous logs on startup by using --lines 0
const initialArgs = pm2Executable
    ? ["logs", APP_NAME, "--raw", "--lines", "0"]
    : ["pm2", "logs", APP_NAME, "--raw", "--lines", "0"];
let pm2Process = spawnPm2Process(initialExecutable, initialArgs);

pm2Process.on("error", (err) => {
    console.error("[ERROR] Failed to start pm2:", err.message);
    if (!triedNpx) {
        console.error("Attempting to run via npx...");
        triedNpx = true;
        pm2Process = spawnPm2Process("npx", ["pm2", "logs", APP_NAME, "--raw", "--lines", "0"]);
        pm2Process.on("error", (err2) => {
            console.error("[ERROR] Failed to start pm2 via npx:", err2.message);
            console.error("Please install pm2 globally (npm i -g pm2) or add it to this project.");
            process.exit(1);
        });
        setupReadersAndHandlers(pm2Process);
        return;
    }
    console.error("Please install pm2 globally (npm i -g pm2) or add it to this project.");
    process.exit(1);
});

pm2Process.on("spawn", () => setupReadersAndHandlers(pm2Process));

function setupReadersAndHandlers(processHandle) {
    const stdoutReader = readline.createInterface({
        input: processHandle.stdout,
        crlfDelay: Infinity,
    });

    const stderrReader = readline.createInterface({
        input: processHandle.stderr,
        crlfDelay: Infinity,
    });

    stdoutReader.on("line", (line) => {
        const out = sanitizePm2Line(line, false);
        if (out) sendLineToDiscord(out);
    });
    stderrReader.on("line", (line) => {
        const out = sanitizePm2Line(line, true);
        if (out) sendLineToDiscord(out);
    });

    processHandle.on("close", (code) => {
        console.error("pm2 logs process exited with code:", code);
        process.exit(code ?? 1);
    });
}

// Webhook send queue + rate-limit handling + simple dedupe
const messageQueue = [];
let sending = false;
let pausedUntil = 0;
let lastSent = { text: null, ts: 0 };
const DEDUPE_WINDOW_MS = 2000;

function enqueueMessage(line) {
    const text = String(line ?? "").trim();
    if (!text) return;

    // Simple dedupe: skip if identical to last sent within window
    const now = Date.now();
    if (lastSent.text === text && now - lastSent.ts < DEDUPE_WINDOW_MS) return;

    // Truncate for Discord safety
    const safeText = text.length > 1900 ? text.slice(0, 1900) + "…" : text;
    messageQueue.push(safeText);
    processQueue();
}

function processQueue() {
    if (sending) return;
    if (messageQueue.length === 0) return;
    const now = Date.now();
    if (pausedUntil && now < pausedUntil) {
        setTimeout(processQueue, Math.max(50, pausedUntil - now));
        return;
    }

    const content = messageQueue.shift();
    sending = true;

    fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `\`\`\`log\n${content}\n\`\`\`` }),
    })
        .then(async (res) => {
            if (res.status === 429) {
                // Rate-limited — try to read retry info
                let retryAfter = 1000;
                try {
                    const body = await res.json();
                    if (body && body.retry_after) retryAfter = Number(body.retry_after) || retryAfter;
                } catch (e) {
                    const hdr = res.headers.get("retry-after");
                    if (hdr) retryAfter = Number(hdr) * 1000 || retryAfter;
                }
                pausedUntil = Date.now() + retryAfter;
                // console.warn("[WARN] Webhook rate-limited, retrying after", retryAfter, "ms");
                // requeue message at front
                messageQueue.unshift(content);
                sending = false;
                setTimeout(processQueue, retryAfter + 50);
                return;
            }

            if (res.status === 429) {
                // handled above
                sending = false;
                return;
            }

            if (!res.ok) {
                console.warn("[WARN] Webhook responded with status", res.status);
            } else {
                lastSent.text = content;
                lastSent.ts = Date.now();
                // try to parse returned message id to schedule deletion
                try {
                    const body = await res.json();
                    if (body && body.id && DELETE_AFTER_MS > 0) {
                        setTimeout(() => enqueueDelete(body.id), DELETE_AFTER_MS);
                    }
                } catch (e) {
                    // ignore parse errors
                }
            }

            sending = false;
            setImmediate(processQueue);
        })
        .catch((err) => {
            console.error("[ERROR] Failed sending webhook:", err && err.message ? err.message : err);
            // network error — requeue with backoff
            messageQueue.unshift(content);
            sending = false;
            setTimeout(processQueue, 1000);
        });
}

// Backwards-compatible API: existing callers call this
function sendLineToDiscord(line) {
    enqueueMessage(line);
}

// Delete queue: delete webhook messages after TTL
const deleteQueue = [];
let deleteSending = false;
let deletePausedUntil = 0;

function enqueueDelete(messageId) {
    if (!messageId) return;
    deleteQueue.push(messageId);
    processDeleteQueue();
}

function processDeleteQueue() {
    if (deleteSending) return;
    if (deleteQueue.length === 0) return;
    const now = Date.now();
    if (deletePausedUntil && now < deletePausedUntil) {
        setTimeout(processDeleteQueue, Math.max(50, deletePausedUntil - now));
        return;
    }

    const messageId = deleteQueue.shift();
    deleteSending = true;

    const delUrl = `${WEBHOOK_URL}/messages/${messageId}`;
    fetch(delUrl, { method: "DELETE" })
        .then(async (res) => {
            if (res.status === 429) {
                let retryAfter = 1000;
                try {
                    const body = await res.json();
                    if (body && body.retry_after) retryAfter = Number(body.retry_after) || retryAfter;
                } catch (e) {
                    const hdr = res.headers.get("retry-after");
                    if (hdr) retryAfter = Number(hdr) * 1000 || retryAfter;
                }
                deletePausedUntil = Date.now() + retryAfter;
                // console.warn("[WARN] Delete rate-limited, retrying after", retryAfter, "ms");
                deleteQueue.unshift(messageId);
                deleteSending = false;
                setTimeout(processDeleteQueue, retryAfter + 50);
                return;
            }

            if (!res.ok && res.status !== 404) {
                console.warn("[WARN] Failed to delete webhook message", messageId, "status", res.status);
            }

            deleteSending = false;
            setImmediate(processDeleteQueue);
        })
        .catch((err) => {
            console.error("[ERROR] Failed deleting webhook message:", err && err.message ? err.message : err);
            deleteQueue.unshift(messageId);
            deleteSending = false;
            setTimeout(processDeleteQueue, 1000);
        });
}

// Sanitize and filter pm2 lines (strip ANSI, ignore headers)
function sanitizePm2Line(raw, isStderr = false) {
    if (raw == null) return null;
    // Remove ANSI escape sequences
    const ansiRegex = /\x1B\[[0-?]*[ -/]*[@-~]/g;
    let text = String(raw).replace(ansiRegex, "").trim();
    if (!text) return null;

    // Ignore pm2 tailing/header lines like: "Y:\.pm2\logs\api-error.log last 15 lines:" or "[TAILING] Tailing last 15 lines..."
    if (/last \d+ lines/i.test(text)) return null;
    if (/^\[?TAILING\]?/i.test(text)) return null;

    // Ignore isolated file path headers
    if (/\.pm2[\\/].*\.log/i.test(text) && /last \d+/i.test(text)) return null;

    // Prefix stderr marker if needed
    if (isStderr && !text.startsWith("[stderr] ")) text = "[stderr] " + text;

    // Try to extract a leading process column, common pm2 formats:
    // Examples:
    //   api    | Message here
    //   api | Message
    //   api│ Message
    //   [api] Message
    // Match "name | message" or "name │ message"
    const procSep = text.match(/^([^\s\|│\[\]]+)\s*[|│:]\s*(.*)$/);
    if (procSep) {
        const proc = procSep[1];
        const rest = procSep[2];
        if (rest && proc) {
            const prefix = `[${String(proc).toUpperCase()}] `;
            return prefix + rest;
        }
    }

    // Match [name] message
    const bracket = text.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (bracket) {
        const proc = bracket[1];
        const rest = bracket[2];
        if (rest && proc) {
            const prefix = `[${String(proc).toUpperCase()}] `;
            text = prefix + rest;
        }
    }

    // If monitoring a single app (APP_NAME != 'all'), prefix with the app name
    if (typeof APP_NAME === "string" && APP_NAME.toLowerCase() !== "all") {
        const appPrefix = `[${APP_NAME.toUpperCase()}] `;
        if (!text.startsWith(appPrefix)) text = appPrefix + text;
    }

    return text;
}
