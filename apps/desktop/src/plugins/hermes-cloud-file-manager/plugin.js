// Generated from src/desktop by scripts/build-desktop.mjs. Do not edit by hand.

// src/desktop/plugin.tsx
import {
  COMPOSER_AREAS,
  host as host5,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA
} from "@hermes/plugin-sdk";

// src/desktop/api.ts
import { atom } from "@hermes/plugin-sdk";

// src/desktop/strings.ts
var machineOf = (profile) => profile && profile !== "default" ? `${profile}'s machine` : "the agent's machine";
var mb = (bytes) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
var S = {
  title: "Cloud Files",
  navLabel: "Cloud Files",
  providerLabel: "Cloud",
  notSetUp: (agent) => `Cloud Files isn't set up on ${agent} yet. Install the Cloud File Manager plugin on the agent and enable it (Capabilities \u25B8 Plugins, or \`hermes plugins enable hermes-cloud-file-manager\`). On Hermes 0.21.6 or later it appears within about a minute; on older versions, restart the agent's gateway.`,
  unsupportedTitle: "Cloud Files can't browse this agent's machine",
  needsUpdateTitle: "Cloud Files needs an update on this agent",
  needsUpdateBody: "The agent's machine has an older version of the Cloud File Manager plugin, or it isn't enabled. Update or enable it there. After an update, restart the agent's gateway.",
  noRootsTitle: "Cloud Files has no folder to show",
  openSettings: "Open settings",
  loadFailed: "Couldn't load files",
  retry: "Retry",
  root: "Folder",
  search: "Search files",
  searchIn: (folder) => `Search in ${folder}`,
  newFolder: "New folder",
  uploadFiles: "Upload files",
  uploadFolder: "Upload folder",
  copyPath: "Copy path",
  maxPerFile: (bytes) => `Up to ${mb(bytes)} per file`,
  emptyFolder: "This folder is empty \u2014 drop files here or use Upload",
  emptyFolderPick: "This folder is empty",
  noResults: "No matching files",
  truncated: (n) => n === 1 ? "Showing the first item" : `Showing the first ${n} items`,
  showingOf: (n, total) => `Showing ${n.toLocaleString()} of ${total.toLocaleString()} items`,
  loadMore: "Load more",
  agentChanged: "The selected agent changed while this folder was loading.",
  firstOnly: (n) => `Showing the first ${n.toLocaleString()} items. Search finds the rest.`,
  searchMore: (n) => `Showing the first ${n === 1 ? "match" : `${n} matches`}. Type more to narrow the search.`,
  searchStopped: (visited) => `Search stopped ${visited ? `after checking ${visited.toLocaleString()} items` : "early"}, so some matches may be missing. Open a folder to search inside it.`,
  noResultsYet: "No matches found so far",
  dropTo: (folder) => `Drop to upload to ${folder}`,
  copied: (n) => n === 1 ? "Path copied" : `${n} paths copied`,
  copyFailed: "Couldn't copy to the clipboard",
  breadcrumbs: "Folder path",
  uploads: "Uploads",
  expand: "Show uploads",
  collapse: "Hide uploads",
  uploadProgress: "Upload progress",
  uploadProgressOf: (path) => `Upload progress for ${path}`,
  // New folder dialog
  folderName: "Folder name",
  create: "Create",
  cancel: "Cancel",
  nameRequired: "Enter a name",
  nameNoSlash: "A folder name cannot contain /",
  folderCreated: (name) => `Created ${name}`,
  // Upload drawer
  uploading: (n, total, sent, size) => `Uploading ${n} of ${total} \xB7 ${sent} of ${size}`,
  uploaded: (done, total, failed) => `Uploaded ${done} of ${total}${failed ? ` \xB7 ${failed} failed` : ""}`,
  canceled: "Upload canceled",
  paused: (profile) => `Switch back to ${profile} to continue uploading`,
  busyElsewhere: "Finish or cancel the current uploads first",
  queued: "Queued",
  done: "Done",
  savedAs: (name) => `Saved as "${name}"`,
  failed: (reason) => `Failed: ${reason}`,
  canceledItem: "Canceled",
  clear: "Clear",
  tooLarge: (max) => `Too large (max ${mb(max)})`,
  // Picker
  pickerTitle: "Attach from Cloud Files",
  // Same profile name means only the connection changed, so the names wouldn't tell the agents apart.
  pickerPinnedElsewhere: (current, pinned) => current === pinned ? "Cloud Files isn't set up on the agent you switched to. Switch back to the agent you opened this on to keep picking files there." : `Cloud Files isn't set up on ${current}. Switch back to ${pinned} to keep picking files there.`,
  drivePinnedElsewhere: (current, pinned) => current === pinned ? "Google Drive isn't available on the agent you switched to. Switch back to the agent you opened this on to keep importing; an import already started there continues when you switch back." : `Google Drive isn't available on ${current}. Switch back to ${pinned} to keep importing; an import already started there continues when you switch back.`,
  selected: (n) => `${n} selected`,
  insert: "Insert locations",
  lineBreakSkipped: (n) => n === 1 ? "A selected name has a line break, so it won\u2019t be inserted." : `${n} selected names have a line break, so they won\u2019t be inserted.`,
  ownerMismatch: (owner, profile) => `This chat belongs to ${owner}. Cloud Files is showing ${profile}'s files \u2014 switch to ${owner} in the sidebar first.`,
  insertHeader: (profile) => `Cloud files on ${machineOf(profile)}:`,
  // Google Drive
  drive: "Google Drive",
  searchDrive: "Search Google Drive",
  driveEmpty: "This folder is empty",
  drivePickerTitle: "Insert from Google Drive",
  importToCloud: "Import to Cloud Files",
  importCount: (n) => `Import ${n} to Cloud Files`,
  importHint: (rootLabel) => `Imports go to ${rootLabel}/uploads/drive`,
  importing: (n, total) => `Importing ${n} of ${total}\u2026`,
  imported: (n) => `Imported ${n} ${n === 1 ? "file" : "files"}`,
  importPaused: (profile) => `Switch back to ${profile} to finish importing`,
  importCanceled: (n) => `Import canceled after ${n} ${n === 1 ? "file" : "files"}`,
  importedTo: (profile) => `These files were imported to ${profile}'s uploads/drive.`,
  copyLocations: "Copy locations",
  locationsCopied: "Locations copied",
  chatChanged: "The chat changed while this was open, so the locations weren't inserted. Copy them instead.",
  importFailed: (name, reason) => `${name}: ${reason}`,
  importAndInsert: "Import and insert",
  show: "Show",
  close: "Close",
  // Editor
  open: "Open",
  edit: "Edit",
  editing: "Editing",
  unsaved: "Unsaved changes",
  changes: "Changes",
  reviewSave: "Review & save",
  save: "Save",
  backToEditing: "Back to editing",
  saved: "Saved",
  notSaved: (name, reason) => `${name} wasn't saved. ${reason}`,
  changedSince: (profile) => `It changed on ${machineOf(profile)} since you opened it.`,
  movedOrDeleted: (profile) => `It was moved or deleted on ${machineOf(profile)}.`,
  loadingFile: "Opening\u2026",
  noChanges: "No changes",
  diffSummary: (added, removed) => `+${added} \u2212${removed} lines`,
  unchangedLines: (n) => `\u22EF ${n} unchanged ${n === 1 ? "line" : "lines"}`,
  diffTooLarge: "Too large to show changes",
  mixedEndings: "This file mixes line endings; saving converts them all to CRLF.",
  reviewTitle: (name) => `Save changes to ${name}?`,
  discardTitle: (name) => `Discard unsaved changes to ${name}?`,
  keepEditing: "Keep editing",
  discard: "Discard",
  conflictTitle: (name, profile) => `${name} changed on ${machineOf(profile)} since you opened it.`,
  compare: "Compare with their version",
  copyMine: "Copy my text",
  textCopied: "Your text is on the clipboard",
  discardReload: "Discard mine and reload",
  goneTitle: (name, profile) => `${name} was moved or deleted on ${machineOf(profile)}.`,
  otherAgent: (profile) => `This file is on ${profile}. Switch back to edit or save.`
};
var CODE_TEXT = {
  exists_file: "A file with that name already exists",
  bad_path: "That name or path is not allowed",
  protected: "That location is protected",
  outside_root: "That location is outside the agent\u2019s folders",
  too_large: "The file is too large",
  bad_data: "The upload data was corrupted",
  gone: "The upload expired on the server",
  size_mismatch: "The file size changed during upload",
  unsupported_backend: "This agent\u2019s storage is not supported",
  unknown_root: "That folder is no longer available",
  not_a_dir: "That is not a folder",
  is_link: "That item is a link outside the agent\u2019s folders",
  bad_query: "That search is not valid",
  unavailable: "Google Drive isn't available for this agent right now.",
  bad_id: "That Google Drive item isn't valid.",
  is_folder: "Choose files, not folders.",
  drive_error: "Google Drive couldn't finish that. Try again.",
  timeout: "Google Drive took too long. Try again.",
  permission_denied: "The agent's user isn't allowed to open or change this.",
  no_space: "The agent's machine is out of disk space.",
  read_only: "This location is read-only.",
  no_roots: "None of the folders in Cloud Files settings can be shown on this machine. Check the paths in the plugin's settings.",
  io_error: "Something went wrong reading or writing on the agent's machine.",
  no_free_name: "No free name is left for this file here. Rename it and try again.",
  chunk_too_large: "Part of the upload was too large for the agent's machine. Try again.",
  offset: "The upload got out of step with the server. Try again.",
  bad_upload_id: "The upload is no longer valid. Try again."
};
var FILE_CODE_TEXT = {
  not_editable: "Only .md, .markdown and .txt files can be opened here.",
  is_link: "This file is a link, so it can\u2019t be opened here.",
  not_a_file: "This isn\u2019t a regular file.",
  hard_link: "This file has other hard links, so it can\u2019t be opened here.",
  mount_point: "This file is a mount point, so it can\u2019t be opened here.",
  not_text: "This file isn\u2019t plain UTF-8 text.",
  changed: "The file changed while it was being read. Try again.",
  outside_root: "This file is outside the agent\u2019s folders.",
  protected: "This file is in a protected location.",
  not_found: "This file no longer exists.",
  bad_path: "That path isn\u2019t allowed."
};
var SAVE_CODE_TEXT = {
  changed: "The file changed while saving, so nothing was written. Try again.",
  is_link: "The file has become a link, so nothing was written.",
  not_a_file: "The file is no longer a regular file, so nothing was written.",
  hard_link: "The file now has other hard links, so nothing was written.",
  mount_point: "The file is now a mount point, so nothing was written.",
  not_text: "This text can\u2019t be saved as UTF-8."
};
var fileCodeText = (code, message, maxBytes, saving = false) => code === "too_large" ? `Too large to ${saving ? "save" : "open"} here (over ${mb(maxBytes ?? 1024 * 1024)}).` : saving && SAVE_CODE_TEXT[code] || FILE_CODE_TEXT[code] || codeText(code, message);
var codeText = (code, message) => code && CODE_TEXT[code] || message || code || "Something went wrong";

// src/desktop/api.ts
var ApiError = class extends Error {
  constructor(code, message, body) {
    super(message);
    this.code = code;
    this.body = body;
  }
  code;
  body;
};
var bound = null;
var $available = atom(null);
var $driveAvailable = atom(null);
function bindContext(ctx) {
  bound = ctx;
}
function pluginCtx() {
  if (!bound) throw new Error("Cloud Files is not registered");
  return bound;
}
function rest(path, opts) {
  return pluginCtx().rest(path, opts);
}
async function call(path, opts) {
  const res = await rest(path, opts);
  const rootsUnsupported = path.split("?")[0] === "/roots" && res?.code === "unsupported_backend";
  if (res && res.ok === false && !rootsUnsupported) throw new ApiError(res.code ?? "error", codeText(res.code, res.message), res);
  return res;
}
function isNotFoundError(error) {
  return httpStatus(error) === 404;
}
function httpStatus(error) {
  const text = error instanceof Error ? error.message : String(error);
  const match = /^\s*(\d{3}):/.exec(text) ?? /Error: (\d{3}):/.exec(text);
  return match ? Number(match[1]) : null;
}
var query = (path, params) => `${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`;
var errorText = (error) => error instanceof Error ? error.message : String(error);

// src/desktop/drive.ts
import { atom as atom2 } from "@hermes/plugin-sdk";

// src/desktop/format.ts
var TICK = "`";
var hasLineBreak = (abs) => abs.includes("\n") || abs.includes("\r");
function longestTickRun(text) {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === TICK ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}
function formatLocation({ abs, is_dir }) {
  const path = is_dir && !abs.endsWith("/") ? `${abs}/` : abs;
  const fence = TICK.repeat(longestTickRun(path) + 1);
  const pad2 = path.startsWith(TICK) || path.endsWith(TICK) ? " " : "";
  return `- ${fence}${pad2}${path}${pad2}${fence}`;
}
function formatInsertText(profile, items) {
  return `
${S.insertHeader(profile)}
${items.map(formatLocation).join("\n")}`;
}
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
function shortDate(mtime, now = /* @__PURE__ */ new Date()) {
  const date = new Date(mtime * 1e3);
  if (Number.isNaN(date.getTime())) return "";
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(void 0, { month: "short", day: "numeric", ...sameYear ? {} : { year: "numeric" } });
}
function joinPath(...parts) {
  return parts.flatMap((part) => part.split("/")).filter(Boolean).join("/");
}
function parentPath(rel) {
  const parts = rel.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}
function baseName(rel) {
  const parts = rel.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
var EDITABLE = /* @__PURE__ */ new Set(["md", "markdown", "txt"]);
function extension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
var isEditable = (entry) => !entry.is_dir && !entry.link_outside && EDITABLE.has(extension(entry.name));
var isMarkdown = (name) => extension(name) !== "txt";
var MEDIA = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "svg", "tif", "tiff", "mp4", "mov", "m4v", "webm", "mkv", "avi"]);
function entryIcon(entry) {
  if (entry.link_outside) return "link";
  if (entry.is_dir) return "folder";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 && MEDIA.has(entry.name.slice(dot + 1).toLowerCase()) ? "file-media" : "file";
}

// src/desktop/upload.ts
var MIN_CHUNK = 256 * 1024;
var REQUEST_TIMEOUT_MS = 12e4;
var CONCURRENCY = 2;
var BACKOFF_MS = [1e3, 2e3, 4e3];
function readBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}
function isShrinkError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return /(^|\D)413(\D|$)/.test(text) || /timed?[ -]?out/i.test(text);
}
function transportText(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method \S+: /, "").replace(/^Error: /, "") || "Connection problem";
}
var Canceled = class extends Error {
};
var Shrink = class extends Error {
};
var UploadBatch = class {
  /** `pin` is the agent the files were picked on (default: the agent selected now). A batch pinned to an
   *  agent that is not selected starts paused and never re-pins. */
  constructor(limits, deps, pin) {
    this.limits = limits;
    this.deps = deps;
    this.readChunk = deps.readChunk ?? readBase64;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.snapshot = {
      profile: pin?.profile ?? deps.state.profile.get(),
      connectionId: pin ? pin.connectionId : deps.state.connectionId.get(),
      items: [],
      running: false,
      paused: false,
      canceled: false
    };
    this.snapshot = { ...this.snapshot, paused: !this.matches() };
  }
  limits;
  deps;
  snapshot;
  blobs = /* @__PURE__ */ new Map();
  inFlight = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  waiters = [];
  pool = null;
  nextId = 1;
  readChunk;
  sleep;
  getSnapshot = () => this.snapshot;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Queue files (and empty dirs) for a destination; oversize files fail before any request. `limits` are the
   *  current /roots limits; they replace the batch's for this and later files. */
  add(input, dest, limits) {
    if (limits) this.limits = limits;
    const items = [];
    for (const rel of input.dirs ?? []) {
      items.push({ id: this.nextId++, root: dest.root, path: joinPath(dest.folder, rel), size: 0, sent: 0, status: "queued", isDir: true });
    }
    for (const { file, rel } of input.files) {
      const id = this.nextId++;
      const tooBig = file.size > this.limits.max_file_bytes;
      if (!tooBig) this.blobs.set(id, file);
      items.push({
        id,
        root: dest.root,
        path: joinPath(dest.folder, rel),
        size: file.size,
        sent: 0,
        status: tooBig ? "failed" : "queued",
        ...tooBig ? { error: S.tooLarge(this.limits.max_file_bytes), retryable: false } : {}
      });
    }
    this.set({ items: [...this.snapshot.items, ...items] });
  }
  /** Run until every queued item is settled. Safe to call again (returns the running pool). */
  start() {
    if (this.pool) return this.pool;
    if (this.snapshot.canceled) return Promise.resolve();
    const wake = () => this.wake();
    const stops = [this.deps.state.connectionId.subscribe(wake), this.deps.state.profile.subscribe(wake)];
    this.set({ running: true });
    this.pool = this.drain().finally(() => {
      stops.forEach((stop) => stop());
      this.pool = null;
      this.set({ running: false, paused: false });
      if (!this.snapshot.canceled && this.snapshot.items.some((item) => item.status === "queued")) void this.start();
    });
    return this.pool;
  }
  retry(id) {
    const item = this.snapshot.items.find((it) => it.id === id);
    if (!item || item.status !== "failed" || item.retryable === false || this.snapshot.canceled) return;
    this.patch(id, { status: "queued", sent: 0, error: void 0 });
    void this.start();
  }
  cancel() {
    if (this.snapshot.canceled) return;
    this.set({
      canceled: true,
      items: this.snapshot.items.map((item) => item.status === "queued" || item.status === "uploading" ? { ...item, status: "canceled" } : item)
    });
    this.blobs.clear();
    for (const id of [...this.inFlight.keys()]) this.abort(id);
    this.wake();
  }
  async drain() {
    for (const item of this.snapshot.items) {
      if (item.isDir && item.status === "queued") await this.guard(item.id, () => this.mkdir(item));
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => this.worker()));
  }
  async worker() {
    for (; ; ) {
      if (this.snapshot.canceled) return;
      const next = this.snapshot.items.find((item) => !item.isDir && item.status === "queued");
      if (!next) return;
      this.patch(next.id, { status: "uploading" });
      await this.guard(next.id, () => this.uploadFile(next));
    }
  }
  async guard(id, run) {
    try {
      await run();
    } catch (error) {
      if (error instanceof Canceled || this.snapshot.canceled) {
        this.abort(id);
        return;
      }
      this.fail(id, { error: transportText(error) });
    }
  }
  async mkdir(item) {
    const res = await this.send("/mkdir", { root: item.root, path: item.path }, false);
    if (res.ok) this.patch(item.id, { status: "done" });
    else this.fail(item.id, { error: codeText(res.code, res.message) });
  }
  async uploadFile(item) {
    const blob = this.blobs.get(item.id);
    const { root, path, size } = item;
    let chunk = Math.max(MIN_CHUNK, this.limits.chunk_bytes);
    let restarted = false;
    restart: for (; ; ) {
      this.patch(item.id, { sent: 0 });
      const started = await this.send("/uploads/start", { root, path, size }, false);
      if (!started.ok || !started.upload_id) return this.fail(item.id, { error: codeText(started.code, started.message) });
      const uploadId = started.upload_id;
      this.inFlight.set(item.id, uploadId);
      if (started.chunk_bytes) chunk = Math.min(chunk, Math.max(MIN_CHUNK, started.chunk_bytes));
      let offset = 0;
      for (; ; ) {
        if (offset >= size) {
          const fin = await this.send("/uploads/finish", { upload_id: uploadId, root, path, size }, false);
          if (fin.ok) {
            this.inFlight.delete(item.id);
            this.blobs.delete(item.id);
            if (this.snapshot.canceled) return;
            const finalName = baseName(fin.entry?.rel ?? fin.entry?.name ?? path);
            this.patch(item.id, { status: "done", sent: size, ...fin.renamed ? { savedAs: finalName } : {} });
            return;
          }
          if (fin.code === "size_mismatch" && typeof fin.size === "number" && fin.size < size) {
            offset = fin.size;
            this.patch(item.id, { sent: offset });
            continue;
          }
          if (fin.code === "gone" && !restarted) {
            restarted = true;
            this.inFlight.delete(item.id);
            continue restart;
          }
          return this.fail(item.id, { error: codeText(fin.code, fin.message) });
        }
        const data = await this.readChunk(blob.slice(offset, Math.min(size, offset + chunk)));
        let res;
        try {
          res = await this.send("/uploads/chunk", { upload_id: uploadId, root, path, offset, data }, chunk > MIN_CHUNK);
        } catch (error) {
          if (!(error instanceof Shrink)) throw error;
          chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
          continue;
        }
        if (res.ok && typeof res.size === "number" && res.size > offset) {
          offset = res.size;
          this.patch(item.id, { sent: offset });
        } else if (res.code === "offset" && typeof res.size === "number") {
          offset = res.size;
          this.patch(item.id, { sent: offset });
        } else if (res.code === "chunk_too_large" && chunk > MIN_CHUNK) {
          chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
        } else if (res.code === "gone" && !restarted) {
          restarted = true;
          this.inFlight.delete(item.id);
          continue restart;
        } else {
          return this.fail(item.id, { error: codeText(res.code, res.message) });
        }
      }
    }
  }
  /** POST with the agent pin, transport retries (1 s / 2 s / 4 s) and — for chunks above the floor — a
   *  Shrink signal on 413/timeout so the caller retries the same offset with half the chunk. */
  async send(path, body, canShrink) {
    for (let attempt = 0; ; ) {
      await this.ready();
      if (this.snapshot.canceled) throw new Canceled();
      if (!this.matches()) continue;
      try {
        return await this.deps.rest(path, { method: "POST", body, timeoutMs: REQUEST_TIMEOUT_MS });
      } catch (error) {
        if (this.snapshot.canceled) throw new Canceled();
        if (canShrink && isShrinkError(error)) throw new Shrink();
        if (attempt >= BACKOFF_MS.length) throw error;
        await this.sleep(BACKOFF_MS[attempt++]);
      }
    }
  }
  matches() {
    return this.deps.state.connectionId.get() === this.snapshot.connectionId && this.deps.state.profile.get() === this.snapshot.profile;
  }
  /** Resolve once the pinned agent is selected again; throw if the batch is canceled meanwhile. */
  async ready() {
    while (!this.snapshot.canceled && !this.matches()) {
      if (!this.snapshot.paused) this.set({ paused: true });
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    if (this.snapshot.canceled) throw new Canceled();
    if (this.snapshot.paused) this.set({ paused: false });
  }
  wake() {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }
  /** Best-effort server-side cleanup of a temp upload; only while the pinned agent is selected. */
  abort(id) {
    const uploadId = this.inFlight.get(id);
    const item = this.snapshot.items.find((it) => it.id === id);
    this.inFlight.delete(id);
    if (!uploadId || !item || !this.matches()) return;
    void this.deps.rest("/uploads/abort", { method: "POST", body: { upload_id: uploadId, root: item.root, path: item.path } }).catch(() => void 0);
  }
  fail(id, { error }) {
    if (this.snapshot.canceled) return;
    this.abort(id);
    this.patch(id, { status: "failed", error });
  }
  patch(id, fields) {
    this.set({ items: this.snapshot.items.map((item) => item.id === id ? { ...item, ...fields } : item) });
  }
  set(fields) {
    this.snapshot = { ...this.snapshot, ...fields };
    this.listeners.forEach((listener) => listener());
  }
};
function summarize(snapshot) {
  const files = snapshot.items.filter((item) => !item.isDir);
  return {
    total: files.length,
    settled: files.filter((item) => item.status !== "queued" && item.status !== "uploading").length,
    done: files.filter((item) => item.status === "done").length,
    failed: files.filter((item) => item.status === "failed").length,
    sent: files.reduce((sum, item) => sum + item.sent, 0),
    size: files.reduce((sum, item) => sum + item.size, 0)
  };
}

// src/desktop/drive.ts
var DRIVE_DEST = "uploads/drive";
var IMPORT_TIMEOUT_MS = 33e4;
var GOOGLE = "application/vnd.google-apps.";
function driveIcon({ mime, is_folder }) {
  const has = (...parts) => parts.some((part) => mime.includes(part));
  if (is_folder) return "folder";
  if (mime === "application/pdf") return "file-pdf";
  if (has("spreadsheet", "excel", "text/csv")) return "table";
  if (has("presentation", "powerpoint")) return "preview";
  if (mime.startsWith("image/") || mime === `${GOOGLE}drawing` || mime === `${GOOGLE}photo`) return "file-media";
  if (mime === `${GOOGLE}document` || has("wordprocessing", "msword") || mime.startsWith("text/")) return "file-text";
  return "file";
}
var DriveImport = class {
  constructor(items, root, pin, deps) {
    this.items = items;
    this.root = root;
    this.deps = deps;
    this.snapshot = { pin, total: items.length, settled: 0, imported: [], failures: [], running: false, paused: false, canceled: false };
  }
  items;
  root;
  deps;
  snapshot;
  listeners = /* @__PURE__ */ new Set();
  wake = () => void 0;
  run = null;
  getSnapshot = () => this.snapshot;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Import every item once, in order. Resolves with the final snapshot (also after a cancel). */
  start() {
    this.run ??= this.drain();
    return this.run;
  }
  /** No request starts after this; the one in flight (if any) still settles and its file stays. */
  cancel() {
    if (this.snapshot.canceled) return;
    this.set({ canceled: true });
    this.wake();
  }
  async drain() {
    const { state, rest: rest2 } = this.deps;
    const wake = () => this.wake();
    const stops = [state.connectionId.subscribe(wake), state.profile.subscribe(wake), this.deps.hold?.subscribe(wake) ?? (() => void 0)];
    this.set({ running: true });
    try {
      for (const item of this.items) {
        while (!this.snapshot.canceled && !this.matches()) {
          this.set({ paused: true });
          await new Promise((resolve) => this.wake = resolve);
        }
        if (this.snapshot.canceled) break;
        this.set({ paused: false });
        let failure = null;
        try {
          const body = { id: item.id, root: this.root, dest: DRIVE_DEST };
          const res = await rest2("/drive/import", { method: "POST", body, timeoutMs: IMPORT_TIMEOUT_MS });
          if (res?.ok && res.entry) this.set({ imported: [...this.snapshot.imported, res.entry] });
          else failure = codeText(res?.code, res?.message);
        } catch (error) {
          failure = transportText(error);
        }
        const failures = failure ? [...this.snapshot.failures, { name: item.name, error: failure }] : this.snapshot.failures;
        this.set({ settled: this.snapshot.settled + 1, failures });
      }
    } finally {
      stops.forEach((stop) => stop());
      this.set({ running: false, paused: false });
    }
    return this.snapshot;
  }
  matches() {
    const { pin } = this.snapshot;
    const { state, hold } = this.deps;
    return state.profile.get() === pin.profile && state.connectionId.get() === pin.connectionId && !hold?.held();
  }
  set(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
};
var $driveJob = atom2(null);

// src/desktop/page.tsx
import {
  atom as atom5,
  Button as Button4,
  Codicon as Codicon4,
  Dialog as Dialog2,
  DialogContent as DialogContent2,
  DialogFooter as DialogFooter2,
  DialogHeader as DialogHeader2,
  DialogTitle as DialogTitle2,
  EmptyState as EmptyState3,
  host as host3,
  Input,
  Skeleton as Skeleton4,
  useQueryClient as useQueryClient2,
  useValue as useValue3
} from "@hermes/plugin-sdk";
import { useEffect as useEffect3, useId, useRef as useRef4, useState as useState4, useSyncExternalStore as useSyncExternalStore2 } from "react";

// src/desktop/browser.tsx
import {
  atom as atom3,
  Button,
  Checkbox,
  Codicon,
  EmptyState,
  ErrorState,
  host,
  SearchField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useQuery,
  useQueryClient,
  useValue
} from "@hermes/plugin-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var LIST_LIMIT = 500;
var LIST_PAGE_MAX = 2e3;
var SEARCH_LIMIT = 200;
var DEBOUNCE_MS = 300;
var SETTINGS_PATH = "/settings?tab=plugins&agent=hermes-cloud-file-manager&plugin=hermes-cloud-file-manager";
function requestFocus(request, at, want = true) {
  request.current = { at, want, from: document.activeElement };
}
function useListFocus(request, ready, at) {
  const list = useRef(null);
  useEffect(() => {
    const req = request.current;
    if (!req || !ready || !list.current || req.at !== at) return;
    request.current = null;
    const now = document.activeElement;
    if (now && now !== document.body && now !== req.from && !list.current.contains(now)) return;
    const rows = [...list.current.querySelectorAll("[role=listitem]")];
    (rows.find((row) => row.getAttribute("data-entry") === req.want) ?? rows[0] ?? list.current).focus();
  });
  return list;
}
function useRowFocus() {
  const [focused, setFocused] = useState(false);
  return {
    focused,
    handlers: { onBlur: () => setFocused(false), onFocus: () => setFocused(true) },
    ring: focused ? { boxShadow: "inset 0 0 0 1px var(--ui-accent, currentColor)" } : void 0
  };
}
var fromKeyboard = (event) => !event?.detail;
function useScope() {
  const connectionId = useValue(host.state.connectionId);
  const profile = useValue(host.state.profile);
  return [connectionId ?? "local", profile];
}
function useRoots() {
  const scope = useScope();
  return useQuery({ queryKey: ["hcfm", ...scope, "roots"], queryFn: () => call("/roots"), retry: 1 });
}
function useDebounced(value, ms) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
var $pickState = atom3(null);
function useBrowser(roots, mode) {
  const [localRootId, setLocalRootId] = useState(roots.roots[0]?.id ?? "");
  const [localPath, setLocalPath] = useState("");
  const [localSearch, setLocalSearch] = useState("");
  const [localSelected, setLocalSelected] = useState(/* @__PURE__ */ new Map());
  const scope = useScope().join("::");
  const picked = useValue($pickState);
  const fresh = () => ({ scope, rootId: roots.roots[0]?.id ?? "", path: "", search: "", selected: /* @__PURE__ */ new Map() });
  const pick = picked?.scope === scope ? picked : fresh();
  useEffect(() => {
    if (mode === "pick" && picked?.scope !== scope) $pickState.set(fresh());
  }, [mode, picked, scope, roots]);
  const write = (key, value) => {
    const current = $pickState.get();
    const prev = current?.scope === scope ? current : fresh();
    $pickState.set({ ...prev, [key]: typeof value === "function" ? value(prev[key]) : value });
  };
  const rootId = mode === "pick" ? pick.rootId : localRootId;
  const path = mode === "pick" ? pick.path : localPath;
  const search = mode === "pick" ? pick.search : localSearch;
  const selected = mode === "pick" ? pick.selected : localSelected;
  const setRootId = mode === "pick" ? (id) => write("rootId", id) : setLocalRootId;
  const setPath = mode === "pick" ? (path2) => write("path", path2) : setLocalPath;
  const setSearch = mode === "pick" ? (text) => write("search", text) : setLocalSearch;
  const setSelected = mode === "pick" ? (value) => write("selected", value) : setLocalSelected;
  const root = roots.roots.find((r) => r.id === rootId) ?? roots.roots[0];
  const debounced = useDebounced(search.trim(), DEBOUNCE_MS);
  const focusNext = useRef(null);
  const navigate = (next) => {
    setPath(next);
    setSearch("");
    if (mode === "page") setSelected(/* @__PURE__ */ new Map());
  };
  return {
    roots,
    root,
    path,
    search,
    query: search.trim() ? debounced : "",
    selected,
    mode,
    focusNext,
    setSearch,
    navigate,
    switchRoot: (id) => {
      setRootId(id);
      navigate("");
      setSelected(/* @__PURE__ */ new Map());
    },
    toggle: (entry) => setSelected((prev) => {
      const next = new Map(prev);
      if (!next.delete(entry.abs)) next.set(entry.abs, entry);
      return next;
    }),
    selectOnly: (entry) => setSelected(/* @__PURE__ */ new Map([[entry.abs, entry]]))
  };
}
var muted = { color: "var(--ui-text-tertiary)" };
var ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
function LoadError({ error, onRetry }) {
  const retry = /* @__PURE__ */ jsx("div", { style: { display: "flex", justifyContent: "center" }, children: /* @__PURE__ */ jsx(Button, { onClick: onRetry, size: "sm", variant: "secondary", children: S.retry }) });
  if (isNotFoundError(error)) {
    return /* @__PURE__ */ jsxs("div", { style: { display: "grid", gap: 8, justifyItems: "center", padding: "8px 32px 32px", textAlign: "center" }, children: [
      /* @__PURE__ */ jsx(EmptyState, { description: S.needsUpdateBody, title: S.needsUpdateTitle }),
      /* @__PURE__ */ jsx("div", { style: { ...muted, fontSize: 11, maxWidth: 560, overflowWrap: "anywhere" }, children: errorText(error) }),
      retry
    ] });
  }
  return /* @__PURE__ */ jsx("div", { style: { padding: 32 }, children: /* @__PURE__ */ jsx(ErrorState, { description: error instanceof ApiError ? error.message : transportText(error), title: S.loadFailed, children: retry }) });
}
function NoRoots({ reason, onOpenSettings }) {
  return /* @__PURE__ */ jsxs("div", { style: { display: "grid", gap: 8, justifyItems: "center", padding: "8px 32px 32px", textAlign: "center" }, children: [
    /* @__PURE__ */ jsx(EmptyState, { description: reason ?? codeText("no_roots"), title: S.noRootsTitle }),
    /* @__PURE__ */ jsx(
      Button,
      {
        onClick: () => {
          onOpenSettings?.();
          host.navigate(SETTINGS_PATH);
        },
        size: "sm",
        variant: "secondary",
        children: S.openSettings
      }
    )
  ] });
}
var DRIVE_VALUE = "hcfm:google-drive";
function RootSelect({ b, drive }) {
  if (b.roots.roots.length < 2 && !drive) return null;
  const change = (value) => {
    drive?.choose(value === DRIVE_VALUE);
    if (value !== DRIVE_VALUE) b.switchRoot(value);
  };
  return /* @__PURE__ */ jsxs(Select, { onValueChange: change, value: drive?.active ? DRIVE_VALUE : b.root?.id, children: [
    /* @__PURE__ */ jsx(SelectTrigger, { "aria-label": S.root, size: "sm", children: /* @__PURE__ */ jsx(SelectValue, {}) }),
    /* @__PURE__ */ jsxs(SelectContent, { children: [
      b.roots.roots.map((root) => /* @__PURE__ */ jsx(SelectItem, { value: root.id, children: root.label }, root.id)),
      drive && /* @__PURE__ */ jsx(SelectItem, { value: DRIVE_VALUE, children: S.drive })
    ] })
  ] });
}
function Breadcrumbs({ b, folder = b.path, rootLabel = b.root?.label ?? "", leaf, onNavigate = b.navigate }) {
  const parts = folder.split("/").filter(Boolean);
  const crumbs = [{ label: rootLabel, path: "" }, ...parts.map((part, i) => ({ label: part, path: parts.slice(0, i + 1).join("/") }))];
  return /* @__PURE__ */ jsxs("nav", { "aria-label": S.breadcrumbs, style: { display: "flex", alignItems: "center", gap: 2, minWidth: 0, flex: 1, fontSize: 12, ...ellipsis }, children: [
    crumbs.map((crumb, i) => {
      const last = i === crumbs.length - 1;
      return /* @__PURE__ */ jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 }, children: [
        i > 0 && /* @__PURE__ */ jsx(Codicon, { name: "chevron-right", size: "0.75rem", style: muted }),
        last && !b.query && !leaf ? /* @__PURE__ */ jsx("span", { style: { ...ellipsis, color: "var(--ui-text-primary)", fontWeight: 500 }, children: crumb.label }) : /* @__PURE__ */ jsx(
          Button,
          {
            onClick: (event) => {
              if (fromKeyboard(event)) requestFocus(b.focusNext, crumb.path);
              onNavigate(crumb.path);
            },
            size: "inline",
            variant: "text",
            children: crumb.label
          }
        )
      ] }, crumb.path || "/");
    }),
    leaf && /* @__PURE__ */ jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 }, children: [
      /* @__PURE__ */ jsx(Codicon, { name: "chevron-right", size: "0.75rem", style: muted }),
      /* @__PURE__ */ jsx("span", { style: { ...ellipsis, color: "var(--ui-text-primary)", fontWeight: 500 }, children: leaf })
    ] })
  ] });
}
function BrowserSearch({ b, label = S.search }) {
  const folder = b.path?.split("/").pop();
  return /* @__PURE__ */ jsx("span", { onKeyDown: (event) => event.key === "Escape" && b.setSearch(""), children: /* @__PURE__ */ jsx(SearchField, { "aria-label": label, onChange: b.setSearch, placeholder: folder ? S.searchIn(folder) : label, value: b.search }) });
}
function sortEntries(entries, highlights, atRoot) {
  const rank = (entry) => atRoot && entry.is_dir && highlights.includes(entry.name) ? highlights.indexOf(entry.name) : highlights.length;
  return [...entries].sort((a, b) => rank(a) - rank(b) || Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
}
async function listUpTo([connectionId, profile], root, path, count, shown) {
  const read = (offset, limit) => {
    if ((host.state.connectionId.get() ?? "local") !== connectionId || host.state.profile.get() !== profile) throw new Error(S.agentChanged);
    return call(query("/list", { root, path, offset, limit }));
  };
  const have = shown?.entries.length ?? 0;
  if (shown && have && have < count && count - have < LIST_PAGE_MAX) {
    const next = await read(have - 1, count - have + 1);
    if (next.total === shown.total && next.entries[0]?.abs === shown.entries[have - 1].abs) {
      const seen2 = new Set(shown.entries.map((entry) => entry.abs));
      return { ...next, entries: [...shown.entries, ...next.entries.filter((entry) => !seen2.has(entry.abs))] };
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const entries = [];
  let last;
  for (let offset = 0; offset < count; offset += LIST_PAGE_MAX) {
    last = await read(offset, Math.min(LIST_PAGE_MAX, count - offset));
    for (const entry of last.entries) if (!seen.has(entry.abs)) {
      seen.add(entry.abs);
      entries.push(entry);
    }
    if (offset + last.entries.length >= last.total) break;
  }
  return { ...last, entries };
}
function EntryList({ b, height, onOpenFile }) {
  const [connectionId, profile] = useScope();
  const rootId = b.root?.id ?? "";
  const folder = `${connectionId}|${profile}|${rootId}|${b.path}`;
  const [range, setRange] = useState({ folder, count: LIST_LIMIT });
  const count = range.folder === folder ? range.count : LIST_LIMIT;
  if (range.folder !== folder) setRange({ folder, count: LIST_LIMIT });
  const listingKey = ["hcfm", connectionId, profile, "list", rootId, b.path, count];
  const client = useQueryClient();
  const searching = Boolean(b.query);
  const listing = useQuery({
    queryKey: listingKey,
    // A first read of this count is a Load more: hand it the listing on screen (the previous count).
    queryFn: () => listUpTo(
      [connectionId, profile],
      rootId,
      b.path,
      count,
      client.getQueryData(listingKey) === void 0 ? client.getQueryData([...listingKey.slice(0, 6), count - LIST_LIMIT]) : void 0
    ),
    placeholderData: (previous, previousQuery) => listingKey.slice(0, 6).every((value, i) => previousQuery?.queryKey[i] === value) ? previous : void 0,
    enabled: Boolean(rootId) && !searching,
    retry: 1
  });
  const found = useQuery({
    queryKey: ["hcfm", connectionId, profile, "search", rootId, b.path, b.query],
    queryFn: () => call(query("/search", { root: rootId, path: b.path, q: b.query, limit: SEARCH_LIMIT })),
    enabled: Boolean(rootId) && searching,
    retry: 1
  });
  const active = searching ? found : listing;
  const entries = useMemo(() => {
    if (searching) return found.data?.results ?? [];
    return sortEntries(listing.data?.entries ?? [], b.roots.highlights ?? [], b.path === "");
  }, [searching, found.data, listing.data, b.roots.highlights, b.path]);
  const truncated = searching ? found.data?.truncated : listing.data?.truncated;
  const reason = searching ? found.data?.reason : void 0;
  const stopped = reason === "time" || reason === "visits";
  const truncationNote = stopped ? S.searchStopped(found.data?.visited ?? 0) : reason === "results" ? S.searchMore(entries.length) : S.truncated(entries.length);
  const list = useListFocus(b.focusNext, Boolean(active.data || active.error), searching ? null : b.path);
  const open = (entry) => {
    if (onOpenFile && isEditable(entry)) return onOpenFile(entry);
    if (!entry.is_dir || entry.link_outside) return;
    b.navigate(entry.rel);
  };
  let body;
  if (active.error) {
    body = /* @__PURE__ */ jsx(LoadError, { error: active.error, onRetry: () => void active.refetch() });
  } else if (!active.data) {
    body = /* @__PURE__ */ jsx("div", { "aria-busy": "true", style: { display: "grid", gap: 6, padding: "8px 12px" }, children: [0, 1, 2, 3, 4].map((i) => /* @__PURE__ */ jsx(Skeleton, { style: { height: 18, opacity: 1 - i * 0.15 } }, i)) });
  } else if (!entries.length) {
    body = /* @__PURE__ */ jsx(EmptyState, { description: stopped ? truncationNote : void 0, title: stopped ? S.noResultsYet : searching ? S.noResults : b.mode === "pick" ? S.emptyFolderPick : S.emptyFolder });
  } else {
    body = /* @__PURE__ */ jsxs("div", { role: "list", children: [
      entries.map((entry) => /* @__PURE__ */ jsx(EntryRow, { b, entry, onOpen: open, searching }, entry.abs)),
      searching ? truncated && /* @__PURE__ */ jsx("div", { style: { ...muted, fontSize: 11, padding: "8px 12px" }, children: truncationNote }) : (listing.data?.total ?? 0) > entries.length ? /* @__PURE__ */ jsxs("div", { style: { ...muted, fontSize: 11, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ jsx("span", { children: S.showingOf(entries.length, listing.data.total) }),
        /* @__PURE__ */ jsx(Button, { disabled: listing.isFetching, onClick: () => setRange({ folder, count: count + LIST_LIMIT }), size: "sm", variant: "text", children: S.loadMore })
      ] }) : truncated && /* @__PURE__ */ jsx("div", { style: { ...muted, fontSize: 11, padding: "8px 12px" }, children: S.firstOnly(entries.length) })
    ] });
  }
  return /* @__PURE__ */ jsx("div", { ref: list, style: { overflowY: "auto", overflowX: "hidden", ...height ? { height } : { flex: 1, minHeight: 0 } }, tabIndex: -1, children: body });
}
function EntryRow({ b, entry, onOpen, searching }) {
  const [hover, setHover] = useState(false);
  const focus = useRowFocus();
  const checked = b.selected.has(entry.abs);
  const note = !searching && b.path === "" ? b.root?.notes?.[entry.rel] ?? b.root?.notes?.[entry.name] : void 0;
  const secondary = searching ? parentPath(entry.rel) || b.root?.label : note;
  const click = () => {
    if (searching && entry.is_dir && !entry.link_outside) return onOpen(entry);
    if (b.mode === "pick") b.toggle(entry);
    else b.selectOnly(entry);
  };
  return /* @__PURE__ */ jsxs(
    "div",
    {
      "aria-selected": checked,
      "data-entry": entry.rel,
      onClick: click,
      onDoubleClick: () => onOpen(entry),
      onKeyDown: (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") {
          if (entry.is_dir && !entry.link_outside) requestFocus(b.focusNext, entry.rel);
          onOpen(entry);
        }
        if (event.key === " ") {
          event.preventDefault();
          b.toggle(entry);
        }
      },
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      ...focus.handlers,
      role: "listitem",
      style: {
        display: "grid",
        gridTemplateColumns: "16px 16px minmax(0, 1fr) 72px 96px",
        alignItems: "center",
        gap: 8,
        minHeight: 28,
        padding: "3px 12px",
        fontSize: 12,
        cursor: "default",
        userSelect: "none",
        opacity: entry.link_outside ? 0.5 : 1,
        background: checked ? "var(--ui-row-active-background)" : hover || focus.focused ? "var(--ui-row-hover-background)" : void 0,
        ...focus.ring
      },
      tabIndex: 0,
      children: [
        /* @__PURE__ */ jsx("span", { onClick: (event) => event.stopPropagation(), style: { display: "inline-flex" }, children: /* @__PURE__ */ jsx(
          Checkbox,
          {
            "aria-label": entry.name,
            checked,
            onCheckedChange: () => b.toggle(entry),
            style: checked ? void 0 : { borderColor: "var(--ui-stroke-secondary)" }
          }
        ) }),
        /* @__PURE__ */ jsx(Codicon, { name: entryIcon(entry), size: "0.875rem", style: { color: entry.is_dir ? "var(--ui-accent)" : "var(--ui-text-secondary)" } }),
        /* @__PURE__ */ jsxs("span", { style: { display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }, children: [
          /* @__PURE__ */ jsx("span", { style: { ...ellipsis, color: "var(--ui-text-primary)" }, children: entry.name }),
          secondary && /* @__PURE__ */ jsx("span", { style: { ...ellipsis, ...muted, fontSize: 11 }, children: secondary })
        ] }),
        /* @__PURE__ */ jsx("span", { style: { ...muted, textAlign: "right", fontVariantNumeric: "tabular-nums" }, children: entry.is_dir ? "" : humanSize(entry.size) }),
        /* @__PURE__ */ jsx("span", { style: { ...muted, textAlign: "right", fontVariantNumeric: "tabular-nums" }, children: shortDate(entry.mtime) })
      ]
    }
  );
}

// src/desktop/drive-browser.tsx
import { Button as Button2, Checkbox as Checkbox2, Codicon as Codicon2, EmptyState as EmptyState2, Skeleton as Skeleton2, useQuery as useQuery2 } from "@hermes/plugin-sdk";
import { useRef as useRef2, useState as useState2, useSyncExternalStore } from "react";
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var muted2 = { color: "var(--ui-text-tertiary)" };
var ellipsis2 = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
function useDriveBrowser() {
  const [trail, setTrail] = useState2([{ id: "root", name: S.drive }]);
  const [search, setSearch] = useState2("");
  const debounced = useDebounced(search.trim(), DEBOUNCE_MS);
  const [selected, setSelected] = useState2(/* @__PURE__ */ new Map());
  const q = search.trim() ? debounced : "";
  const focusNext = useRef2(null);
  const goTo = (next) => {
    setTrail(next);
    setSearch("");
  };
  return {
    trail,
    folder: trail[trail.length - 1].id,
    search,
    q,
    selected,
    focusNext,
    setSearch,
    /** A folder opened from search results has no known path: it hangs directly off the Drive root. */
    open: (item) => goTo(q ? [trail[0], item] : [...trail, item]),
    crumb: (index) => goTo(trail.slice(0, index + 1)),
    toggle: (item) => setSelected((prev) => {
      const next = new Map(prev);
      if (!next.delete(item.id)) next.set(item.id, item);
      return next;
    }),
    clear: () => setSelected(/* @__PURE__ */ new Map())
  };
}
function DriveCrumbs({ d }) {
  return /* @__PURE__ */ jsx2("nav", { "aria-label": S.breadcrumbs, style: { display: "flex", alignItems: "center", gap: 2, minWidth: 0, flex: 1, fontSize: 12, ...ellipsis2 }, children: d.trail.map((crumb, i) => /* @__PURE__ */ jsxs2("span", { style: { display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 }, children: [
    i > 0 && /* @__PURE__ */ jsx2(Codicon2, { name: "chevron-right", size: "0.75rem", style: muted2 }),
    i === d.trail.length - 1 && !d.q ? /* @__PURE__ */ jsx2("span", { style: { ...ellipsis2, color: "var(--ui-text-primary)", fontWeight: 500 }, children: crumb.name }) : /* @__PURE__ */ jsx2(
      Button2,
      {
        onClick: (event) => {
          if (fromKeyboard(event)) requestFocus(d.focusNext, crumb.id);
          d.crumb(i);
        },
        size: "inline",
        variant: "text",
        children: crumb.name
      }
    )
  ] }, `${i}:${crumb.id}`)) });
}
function DriveList({ d, height }) {
  const [connectionId, profile] = useScope();
  const list = useQuery2({
    queryKey: ["hcfm", connectionId, profile, "drive", d.folder, d.q],
    queryFn: () => call(query("/drive/list", d.q ? { folder: d.folder, q: d.q } : { folder: d.folder })),
    retry: 1
  });
  const items = list.data?.items ?? [];
  const sized = items.some((item) => item.size != null);
  const ref = useListFocus(d.focusNext, Boolean(list.data || list.error), d.q ? null : d.folder);
  let body;
  if (list.error) {
    body = /* @__PURE__ */ jsx2(LoadError, { error: list.error, onRetry: () => void list.refetch() });
  } else if (!list.data) {
    body = /* @__PURE__ */ jsx2("div", { "aria-busy": "true", style: { display: "grid", gap: 6, padding: "8px 12px" }, children: [0, 1, 2, 3, 4].map((i) => /* @__PURE__ */ jsx2(Skeleton2, { style: { height: 18, opacity: 1 - i * 0.15 } }, i)) });
  } else if (!items.length) {
    body = /* @__PURE__ */ jsx2(EmptyState2, { title: d.q ? S.noResults : S.driveEmpty });
  } else {
    body = /* @__PURE__ */ jsxs2("div", { role: "list", children: [
      items.map((item) => /* @__PURE__ */ jsx2(DriveRow, { d, item, sized }, item.id)),
      list.data.truncated && /* @__PURE__ */ jsx2("div", { style: { ...muted2, fontSize: 11, padding: "8px 12px" }, children: S.truncated(items.length) })
    ] });
  }
  return /* @__PURE__ */ jsx2("div", { ref, style: { overflowY: "auto", overflowX: "hidden", ...height ? { height } : { flex: 1, minHeight: 0 } }, tabIndex: -1, children: body });
}
function DriveRow({ d, item, sized }) {
  const [hover, setHover] = useState2(false);
  const focus = useRowFocus();
  const checked = d.selected.has(item.id);
  const activate = () => item.is_folder ? d.open(item) : d.toggle(item);
  return /* @__PURE__ */ jsxs2(
    "div",
    {
      "aria-selected": checked,
      "data-entry": item.id,
      onClick: activate,
      onKeyDown: (event) => {
        if (event.target !== event.currentTarget || event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (item.is_folder) requestFocus(d.focusNext, item.id);
        activate();
      },
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      ...focus.handlers,
      role: "listitem",
      style: {
        display: "grid",
        gridTemplateColumns: `16px 16px minmax(0, 1fr)${sized ? " 72px" : ""} 96px`,
        alignItems: "center",
        gap: 8,
        minHeight: 28,
        padding: "3px 12px",
        fontSize: 12,
        cursor: "default",
        userSelect: "none",
        background: checked ? "var(--ui-row-active-background)" : hover || focus.focused ? "var(--ui-row-hover-background)" : void 0,
        ...focus.ring
      },
      tabIndex: 0,
      children: [
        /* @__PURE__ */ jsx2("span", { onClick: (event) => event.stopPropagation(), style: { display: "inline-flex" }, children: !item.is_folder && /* @__PURE__ */ jsx2(
          Checkbox2,
          {
            "aria-label": item.name,
            checked,
            onCheckedChange: () => d.toggle(item),
            style: checked ? void 0 : { borderColor: "var(--ui-stroke-secondary)" }
          }
        ) }),
        /* @__PURE__ */ jsx2(Codicon2, { name: driveIcon(item), size: "0.875rem", style: { color: item.is_folder ? "var(--ui-accent)" : "var(--ui-text-secondary)" } }),
        /* @__PURE__ */ jsx2("span", { style: { ...ellipsis2, color: "var(--ui-text-primary)" }, children: item.name }),
        sized && /* @__PURE__ */ jsx2("span", { style: { ...muted2, textAlign: "right", fontVariantNumeric: "tabular-nums" }, children: item.is_folder ? "" : item.size == null ? "\u2014" : humanSize(item.size) }),
        /* @__PURE__ */ jsx2("span", { style: { ...muted2, textAlign: "right", fontVariantNumeric: "tabular-nums" }, children: item.mtime ? shortDate(Date.parse(item.mtime) / 1e3) : "" })
      ]
    }
  );
}
var noop = () => () => void 0;
var none = () => null;
function useImport(job) {
  return useSyncExternalStore(job?.subscribe ?? noop, job?.getSnapshot ?? none, job?.getSnapshot ?? none);
}
function importStatus(snap) {
  if (snap.canceled && !snap.running) return S.importCanceled(snap.imported.length);
  if (snap.paused) return S.importPaused(snap.pin.profile);
  if (snap.running) return S.importing(Math.min(snap.total, snap.settled + 1), snap.total);
  return S.imported(snap.imported.length);
}
function ImportFailures({ failures }) {
  if (!failures.length) return null;
  return /* @__PURE__ */ jsx2("div", { style: { display: "grid", gap: 2, maxHeight: 120, overflowY: "auto", fontSize: 11, color: "var(--ui-red)" }, children: failures.map((failure, i) => /* @__PURE__ */ jsx2("div", { style: ellipsis2, children: S.importFailed(failure.name, failure.error) }, i)) });
}

// src/desktop/editor.tsx
import {
  atom as atom4,
  Button as Button3,
  Codicon as Codicon3,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  host as host2,
  Skeleton as Skeleton3,
  Streamdown,
  Textarea,
  useValue as useValue2
} from "@hermes/plugin-sdk";
import { useEffect as useEffect2, useLayoutEffect, useMemo as useMemo2, useRef as useRef3, useState as useState3 } from "react";

// src/desktop/diff.ts
var MAX_DIFF_LINES = 2e4;
var MAX_EDITS = 2e3;
var linesOf = (text) => text === "" ? [] : text.split("\n");
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || k !== d && v[offset + k - 1] < v[offset + k + 1] ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d, offset);
    }
  }
  return null;
}
function backtrack(trace, n, m, depth, offset) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = depth; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || k !== d && v[offset + k - 1] < v[offset + k + 1];
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("same");
      x--;
      y--;
    }
    ops.push(down ? "add" : "del");
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    ops.push("same");
    x--;
    y--;
  }
  return ops.reverse();
}
function lineDiff(before, after, context = 3) {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return { tooLarge: true, added: 0, removed: 0, rows: [] };
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const middle = myers(midA, midB) ?? [...midA.map(() => "del"), ...midB.map(() => "add")];
  const ops = [...Array(head).fill("same"), ...middle, ...Array(tail).fill("same")];
  const full = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "same") full.push({ kind: "same", text: a[i], old: ++i, new: ++j });
    else if (op === "del") full.push({ kind: "del", text: a[i], old: ++i });
    else full.push({ kind: "add", text: b[j], new: ++j });
  }
  const added = full.filter((row) => row.kind === "add").length;
  const removed = full.filter((row) => row.kind === "del").length;
  if (!added && !removed) return { tooLarge: false, added, removed, rows: [] };
  const rows = [];
  for (let start = 0; start < full.length; ) {
    if (full[start].kind !== "same") {
      rows.push(full[start++]);
      continue;
    }
    let end = start;
    while (end < full.length && full[end].kind === "same") end++;
    const keepBefore = start === 0 ? 0 : context;
    const keepAfter = end === full.length ? 0 : context;
    if (end - start > keepBefore + keepAfter) {
      rows.push(...full.slice(start, start + keepBefore), { kind: "skip", count: end - start - keepBefore - keepAfter }, ...full.slice(end - keepAfter, end));
    } else {
      rows.push(...full.slice(start, end));
    }
    start = end;
  }
  return { tooLarge: false, added, removed, rows };
}

// src/desktop/editor.tsx
import { Fragment, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var BOM = "\uFEFF";
var mono = "var(--font-mono, ui-monospace, monospace)";
var muted3 = { color: "var(--ui-text-tertiary)" };
function decodeText(raw) {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  const crlf = body.includes("\r\n");
  const text = crlf ? body.replaceAll("\r\n", "\n") : body;
  return { text, bom, crlf, mixed: crlf && body.replaceAll("\r\n", "").includes("\n") };
}
var encodeText = (text, { bom, crlf }) => (bom ? BOM : "") + (crlf ? text.replaceAll("\n", "\r\n") : text);
var isDirty = (doc) => Boolean(doc && doc.status === "ready" && doc.draft !== doc.base);
var isCurrent = (pin) => pin.connectionId === host2.state.connectionId.get() && pin.profile === host2.state.profile.get();
var $drafts = atom4(/* @__PURE__ */ new Map());
var draftKey = (doc) => [doc.pin.connectionId ?? "local", doc.pin.profile, doc.root, doc.path].join("|");
function setDraft(doc, keep) {
  const next = new Map($drafts.get());
  if (keep) next.set(draftKey(doc), doc);
  else next.delete(draftKey(doc));
  $drafts.set(next);
}
function savedAs(doc, sent, sha) {
  const next = { ...doc, base: sent, sha, mixed: false };
  return doc.draft === sent || doc.mode === "view" ? { ...next, draft: sent, mode: "view" } : next;
}
var mounted = /* @__PURE__ */ new Map();
function settleSave(sent, sha, own) {
  const settle = (d) => d && d.id === sent.id && d.sha === sent.sha ? savedAs(d, sent.draft, sha) : d;
  for (const set of /* @__PURE__ */ new Set([own, ...mounted.keys()])) set(settle);
  const parked = $drafts.get().get(draftKey(sent));
  if (parked && parked.id === sent.id && parked.sha === sent.sha) setDraft(savedAs(parked, sent.draft, sha), true);
}
function stillThere(doc) {
  return [...mounted.values()].some((get) => get()?.id === doc.id) || $drafts.get().get(draftKey(doc))?.id === doc.id;
}
function findParked(pin) {
  return [...$drafts.get().values()].find((d) => d.pin.connectionId === pin.connectionId && d.pin.profile === pin.profile) ?? null;
}
function useOpenDoc() {
  const connectionId = useValue2(host2.state.connectionId);
  const profile = useValue2(host2.state.profile);
  const [doc, setDoc] = useState3(() => findParked({ connectionId, profile }));
  const latest = useRef3(doc);
  latest.current = doc;
  useEffect2(() => {
    mounted.set(setDoc, () => latest.current);
    const restored = latest.current;
    if (restored) {
      const parked = $drafts.get().get(draftKey(restored));
      if (parked && parked !== restored && parked.id === restored.id) setDoc(parked);
      setDraft(restored, false);
    }
    return () => {
      mounted.delete(setDoc);
      const last = latest.current;
      if (last && last.mode === "edit" && isDirty(last)) setDraft(last, true);
    };
  }, []);
  useEffect2(() => {
    if (latest.current) return;
    const parked = findParked({ connectionId, profile });
    if (parked) {
      setDraft(parked, false);
      setDoc(parked);
    }
  }, [connectionId, profile]);
  return [doc, setDoc];
}
var generation = 0;
function loadText(error) {
  if (error instanceof ApiError) return fileCodeText(error.code, error.body?.message, error.body?.max_bytes);
  return isNotFoundError(error) ? S.needsUpdateBody : transportText(error);
}
function load(doc, setDoc) {
  const id = ++generation;
  setDoc({ ...doc, id, status: "loading", error: void 0, mode: "view" });
  call(query("/file", { root: doc.root, path: doc.path })).then(
    (res) => {
      const { text, ...flags } = decodeText(res.text);
      setDoc((d) => d?.id === id ? { ...d, ...flags, status: "ready", base: text, draft: text, sha: res.sha256 } : d);
    },
    (error) => setDoc((d) => d?.id === id ? { ...d, status: "error", error: loadText(error) } : d)
  );
}
function openDoc(entry, root, pin, setDoc) {
  const base = { bom: false, crlf: false, mixed: false, base: "", draft: "", sha: "" };
  load({ ...base, id: 0, pin, root: root.id, rootLabel: root.label, path: entry.rel, abs: entry.abs, name: entry.name, status: "loading", mode: "view" }, setDoc);
}
function useLeaveGuard(doc) {
  const [pending, setPending] = useState3(null);
  const leave = (action) => isDirty(doc) ? setPending(() => action) : action();
  const dialog = /* @__PURE__ */ jsx3(Dialog, { onOpenChange: (open) => !open && setPending(null), open: Boolean(pending && doc), children: /* @__PURE__ */ jsxs3(DialogContent, { style: { maxWidth: 400 }, children: [
    /* @__PURE__ */ jsx3(DialogHeader, { children: /* @__PURE__ */ jsx3(DialogTitle, { children: S.discardTitle(doc?.name ?? "") }) }),
    /* @__PURE__ */ jsxs3(DialogFooter, { children: [
      /* @__PURE__ */ jsx3(Button3, { onClick: () => setPending(null), variant: "text", children: S.keepEditing }),
      /* @__PURE__ */ jsx3(
        Button3,
        {
          onClick: () => {
            pending?.();
            setPending(null);
          },
          variant: "destructive",
          children: S.discard
        }
      )
    ] })
  ] }) });
  return { leave, dialog };
}
function copy(text, message) {
  void pluginCtx().os.writeClipboard(text).then((ok) => ok, () => false).then((ok) => host2.notify(ok ? { kind: "success", message } : { kind: "error", message: S.copyFailed }));
}
function Editor({ doc, setDoc, onClose, leave }) {
  const connectionId = useValue2(host2.state.connectionId);
  const profile = useValue2(host2.state.profile);
  const here = doc.pin.connectionId === connectionId && doc.pin.profile === profile;
  const [popup, setPopup] = useState3(null);
  const [changes, setChanges] = useState3(false);
  const [busy, setBusy] = useState3(false);
  const [saveError, setSaveError] = useState3("");
  const [saved, setSaved] = useState3(false);
  const latest = useRef3(doc);
  latest.current = doc;
  const popupRef = useRef3(popup);
  popupRef.current = popup;
  const live = useRef3(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const dirty = isDirty(doc);
  const editing = doc.mode === "edit";
  const diff = useMemo2(() => popup === "review" || changes ? lineDiff(doc.base, doc.draft) : null, [popup, changes, doc.base, doc.draft]);
  useEffect2(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 4e3);
    return () => clearTimeout(timer);
  }, [saved]);
  const review = () => {
    if (!dirty || !here) return;
    setSaveError("");
    setPopup("review");
  };
  const keyDown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (editing) review();
    }
  };
  const save = async () => {
    if (!isCurrent(doc.pin) || !isDirty(doc) || busy) return;
    const sent = doc.draft;
    setBusy(true);
    setSaveError("");
    try {
      const res = await call("/file/save", {
        method: "POST",
        body: { root: doc.root, path: doc.path, base_sha256: doc.sha, text: encodeText(sent, doc) }
      });
      settleSave(doc, res.sha256, setDoc);
      setPopup(null);
      setChanges(false);
      setSaved(true);
    } catch (error) {
      if (latest.current.id === doc.id && latest.current.mode === "view") return;
      if (!live.current && !stillThere(doc)) return;
      if (error instanceof ApiError && error.code === "conflict") {
        setPopup({ conflict: { sha: error.body?.sha256, text: error.body?.text } });
        if (!live.current) host2.notify({ kind: "error", message: S.notSaved(doc.name, S.changedSince(doc.pin.profile)) });
      } else if (error instanceof ApiError && error.code === "gone") {
        setPopup("gone");
        if (!live.current) host2.notify({ kind: "error", message: S.notSaved(doc.name, S.movedOrDeleted(doc.pin.profile)) });
      } else {
        const message = error instanceof ApiError ? fileCodeText(error.code, error.body?.message, error.body?.max_bytes, true) : transportText(error);
        setSaveError(message);
        if (!live.current || popupRef.current !== "review") host2.notify({ kind: "error", message: S.notSaved(doc.name, message) });
      }
    } finally {
      setBusy(false);
    }
  };
  const compare = (theirs) => {
    if (typeof theirs.text !== "string") return;
    const { text, ...flags } = decodeText(theirs.text);
    setDoc((d) => d?.id === doc.id ? { ...d, ...flags, base: text, sha: theirs.sha } : d);
    setPopup("review");
  };
  const reload = () => {
    if (!isCurrent(doc.pin)) return;
    setPopup(null);
    setChanges(false);
    load(doc, setDoc);
  };
  const cancel = () => leave(() => setDoc((d) => d?.id === doc.id ? { ...d, draft: d.base, mode: "view" } : d));
  const conflict = popup && typeof popup === "object" ? popup.conflict : null;
  let body;
  if (doc.status === "loading") {
    body = /* @__PURE__ */ jsx3("div", { "aria-busy": "true", "aria-label": S.loadingFile, style: { display: "grid", gap: 6, padding: "12px 20px" }, children: [0, 1, 2].map((i) => /* @__PURE__ */ jsx3(Skeleton3, { style: { height: 16 } }, i)) });
  } else if (doc.status === "error") {
    body = /* @__PURE__ */ jsx3("p", { style: { ...muted3, fontSize: 13, padding: "12px 20px" }, children: doc.error });
  } else if (editing && changes) {
    body = /* @__PURE__ */ jsx3(DiffView, { diff, style: { flex: 1, minHeight: 0, margin: "0 20px 12px" } });
  } else if (editing) {
    body = /* @__PURE__ */ jsx3("div", { style: { flex: 1, minHeight: 0, display: "flex", padding: "0 20px 12px" }, children: /* @__PURE__ */ jsx3(
      Textarea,
      {
        "aria-label": doc.name,
        onChange: (event) => setDoc((d) => d?.id === doc.id ? { ...d, draft: event.target.value } : d),
        readOnly: !here,
        spellCheck: false,
        style: { flex: 1, height: "100%", resize: "none", fontFamily: mono, fontSize: 12, lineHeight: 1.5 },
        value: doc.draft
      }
    ) });
  } else {
    body = /* @__PURE__ */ jsx3("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 20px 20px", fontSize: 13, lineHeight: 1.6 }, children: isMarkdown(doc.name) ? (
      // Inset so list markers (drawn outside the text column) stay inside the page instead of the gutter.
      /* @__PURE__ */ jsx3("div", { style: { paddingLeft: 24 }, children: /* @__PURE__ */ jsx3(Streamdown, { controls: false, mode: "static", parseIncompleteMarkdown: false, children: doc.base }) })
    ) : /* @__PURE__ */ jsx3("pre", { style: { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: mono, fontSize: 12 }, children: doc.base }) });
  }
  return /* @__PURE__ */ jsxs3("div", { onKeyDown: keyDown, style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ jsxs3("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 20px", fontSize: 12 }, children: [
      /* @__PURE__ */ jsxs3(Button3, { onClick: () => leave(onClose), size: "sm", variant: "ghost", children: [
        /* @__PURE__ */ jsx3(Codicon3, { name: "arrow-left", size: "0.875rem" }),
        S.close
      ] }),
      editing ? /* @__PURE__ */ jsxs3("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }, children: [
        S.editing,
        dirty && /* @__PURE__ */ jsxs3("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 400, ...muted3 }, children: [
          /* @__PURE__ */ jsx3("span", { style: { width: 6, height: 6, borderRadius: 3, background: "var(--ui-accent)" } }),
          S.unsaved
        ] }),
        doc.mixed && /* @__PURE__ */ jsx3("span", { style: { fontWeight: 400, ...muted3 }, children: S.mixedEndings })
      ] }) : /* @__PURE__ */ jsxs3("span", { style: { display: "inline-flex", alignItems: "baseline", gap: 8, minWidth: 0 }, children: [
        /* @__PURE__ */ jsx3("span", { style: { fontWeight: 600 }, children: doc.name }),
        /* @__PURE__ */ jsx3("span", { style: muted3, children: doc.pin.profile }),
        /* @__PURE__ */ jsx3("span", { style: { ...muted3, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: doc.abs }),
        saved && /* @__PURE__ */ jsx3("span", { "aria-live": "polite", role: "status", style: { color: "var(--ui-green)" }, children: S.saved })
      ] }),
      /* @__PURE__ */ jsx3("span", { style: { marginLeft: "auto", display: "inline-flex", gap: 6 }, children: editing ? /* @__PURE__ */ jsxs3(Fragment, { children: [
        /* @__PURE__ */ jsx3(Button3, { "aria-pressed": changes, onClick: () => setChanges(!changes), size: "sm", variant: changes ? "secondary" : "ghost", children: S.changes }),
        /* @__PURE__ */ jsx3(Button3, { onClick: cancel, size: "sm", variant: "text", children: S.cancel }),
        /* @__PURE__ */ jsx3(Button3, { disabled: !dirty || !here, onClick: review, size: "sm", children: S.reviewSave })
      ] }) : /* @__PURE__ */ jsxs3(Fragment, { children: [
        /* @__PURE__ */ jsx3(Button3, { onClick: () => copy(doc.abs, S.copied(1)), size: "sm", variant: "ghost", children: S.copyPath }),
        /* @__PURE__ */ jsx3(Button3, { disabled: doc.status !== "ready" || !here, onClick: () => setDoc((d) => d?.id === doc.id ? { ...d, mode: "edit" } : d), size: "sm", children: S.edit })
      ] }) })
    ] }),
    !here && /* @__PURE__ */ jsx3("div", { role: "status", style: { margin: "0 20px 8px", padding: "6px 10px", borderRadius: 6, fontSize: 12, background: "color-mix(in srgb, var(--ui-yellow, #d4a72c) 14%, transparent)", color: "var(--ui-text-primary, currentColor)" }, children: S.otherAgent(doc.pin.profile) }),
    body,
    /* @__PURE__ */ jsx3(Dialog, { onOpenChange: (open) => !open && setPopup(null), open: popup === "review", children: /* @__PURE__ */ jsxs3(DialogContent, { style: { maxWidth: 760 }, children: [
      /* @__PURE__ */ jsx3(DialogHeader, { children: /* @__PURE__ */ jsx3(DialogTitle, { children: S.reviewTitle(doc.name) }) }),
      diff && !diff.tooLarge && /* @__PURE__ */ jsx3("div", { style: { ...muted3, fontSize: 12 }, children: S.diffSummary(diff.added, diff.removed) }),
      diff && /* @__PURE__ */ jsx3(DiffView, { diff, style: { maxHeight: "60vh" } }),
      doc.mixed && /* @__PURE__ */ jsx3("div", { style: { ...muted3, fontSize: 12 }, children: S.mixedEndings }),
      saveError && /* @__PURE__ */ jsx3("div", { role: "alert", style: { color: "var(--ui-red)", fontSize: 12 }, children: saveError }),
      /* @__PURE__ */ jsxs3(DialogFooter, { children: [
        /* @__PURE__ */ jsx3(Button3, { onClick: () => setPopup(null), variant: "text", children: S.backToEditing }),
        /* @__PURE__ */ jsx3(Button3, { disabled: !here || !dirty || busy, loading: busy, onClick: () => void save(), children: S.save })
      ] })
    ] }) }),
    /* @__PURE__ */ jsx3(Dialog, { onOpenChange: (open) => !open && setPopup(null), open: Boolean(conflict), children: /* @__PURE__ */ jsxs3(DialogContent, { style: { maxWidth: 460 }, children: [
      /* @__PURE__ */ jsx3(DialogHeader, { children: /* @__PURE__ */ jsx3(DialogTitle, { children: S.conflictTitle(doc.name, doc.pin.profile) }) }),
      /* @__PURE__ */ jsxs3(DialogFooter, { style: { flexWrap: "wrap" }, children: [
        /* @__PURE__ */ jsx3(Button3, { onClick: () => setPopup(null), variant: "text", children: S.backToEditing }),
        /* @__PURE__ */ jsx3(Button3, { onClick: () => copy(doc.draft, S.textCopied), variant: "secondary", children: S.copyMine }),
        /* @__PURE__ */ jsx3(Button3, { disabled: !here, onClick: reload, variant: "secondary", children: S.discardReload }),
        /* @__PURE__ */ jsx3(Button3, { disabled: typeof conflict?.text !== "string", onClick: () => conflict && compare(conflict), children: S.compare })
      ] })
    ] }) }),
    /* @__PURE__ */ jsx3(Dialog, { onOpenChange: (open) => !open && setPopup(null), open: popup === "gone", children: /* @__PURE__ */ jsxs3(DialogContent, { style: { maxWidth: 420 }, children: [
      /* @__PURE__ */ jsx3(DialogHeader, { children: /* @__PURE__ */ jsx3(DialogTitle, { children: S.goneTitle(doc.name, doc.pin.profile) }) }),
      /* @__PURE__ */ jsxs3(DialogFooter, { children: [
        /* @__PURE__ */ jsx3(Button3, { onClick: () => copy(doc.draft, S.textCopied), variant: "secondary", children: S.copyMine }),
        /* @__PURE__ */ jsx3(
          Button3,
          {
            onClick: () => {
              setPopup(null);
              leave(onClose);
            },
            children: S.close
          }
        )
      ] })
    ] }) })
  ] });
}
var DIFF_COLORS = {
  add: { background: "var(--ui-diff-add-background, color-mix(in srgb, var(--ui-green) 12%, transparent))", color: "var(--ui-diff-add-foreground, var(--ui-green))" },
  del: { background: "var(--ui-diff-remove-background, color-mix(in srgb, var(--ui-red) 12%, transparent))", color: "var(--ui-diff-remove-foreground, var(--ui-red))" },
  same: {}
};
function DiffView({ diff, style }) {
  const frame = { overflow: "auto", border: "1px solid var(--ui-stroke-tertiary)", borderRadius: 6, fontFamily: mono, fontSize: 11.5, lineHeight: 1.5, ...style };
  if (diff.tooLarge || !diff.rows.length) {
    return /* @__PURE__ */ jsx3("div", { style: { ...frame, ...muted3, padding: "8px 10px", fontFamily: void 0 }, children: diff.tooLarge ? S.diffTooLarge : S.noChanges });
  }
  return /* @__PURE__ */ jsx3("div", { style: frame, children: diff.rows.map(
    (row, i) => row.kind === "skip" ? /* @__PURE__ */ jsx3("div", { style: { ...muted3, padding: "2px 10px", background: "var(--ui-row-hover-background)" }, children: S.unchangedLines(row.count) }, i) : /* @__PURE__ */ jsxs3("div", { "data-diff": row.kind, style: { display: "grid", gridTemplateColumns: "3.5em 3.5em 1.5em minmax(0, 1fr)", ...DIFF_COLORS[row.kind] }, children: [
      /* @__PURE__ */ jsx3("span", { style: { ...muted3, textAlign: "right", paddingRight: 6 }, children: row.old ?? "" }),
      /* @__PURE__ */ jsx3("span", { style: { ...muted3, textAlign: "right", paddingRight: 6 }, children: row.new ?? "" }),
      /* @__PURE__ */ jsx3("span", { style: { textAlign: "center" }, children: row.kind === "add" ? "+" : row.kind === "del" ? "\u2212" : "" }),
      /* @__PURE__ */ jsx3("span", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", paddingRight: 10 }, children: row.text })
    ] }, i)
  ) });
}

// src/desktop/walk.ts
function collectDropEntries(transfer) {
  const entries = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  return { entries, files: entries.length ? [] : Array.from(transfer.files ?? []) };
}
var readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
var fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
async function walkEntries(entries) {
  const out = { files: [], dirs: [] };
  const visit = async (entry, prefix) => {
    const rel = joinPath(prefix, entry.name);
    if (entry.isFile && entry.file) {
      out.files.push({ file: await fileOf(entry), rel });
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      let children = 0;
      for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
        children += batch.length;
        for (const child of batch) await visit(child, rel);
      }
      if (!children) out.dirs.push(rel);
    }
  };
  for (const entry of entries) await visit(entry, "");
  return out;
}
function filesFromInput(list) {
  return {
    files: Array.from(list).map((file) => ({
      file,
      rel: joinPath(file.webkitRelativePath || file.name)
    })),
    dirs: []
  };
}

// src/desktop/page.tsx
import { Fragment as Fragment2, jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
var muted4 = { color: "var(--ui-text-tertiary)" };
var pad = "0 20px";
var $batch = atom5(null);
var currentPin = () => ({ connectionId: host3.state.connectionId.get(), profile: host3.state.profile.get() });
function enqueueUpload(input, dest, limits, pin = currentPin()) {
  if (!input.files.length && !input.dirs?.length) return;
  let batch = $batch.get();
  const snap = batch?.getSnapshot();
  const sameAgent = snap?.profile === pin.profile && snap?.connectionId === pin.connectionId;
  if (snap?.running && !snap.canceled && !sameAgent) {
    host3.notify({ kind: "warning", message: S.busyElsewhere });
    return;
  }
  if (!batch || !snap || snap.canceled || !sameAgent) {
    batch = new UploadBatch(limits, { rest, state: host3.state }, pin);
    $batch.set(batch);
  }
  batch.add(input, dest, limits);
  void batch.start();
}
function CloudFilesPage() {
  const available = useValue3($available);
  const profile = useValue3(host3.state.profile);
  const connectionId = useValue3(host3.state.connectionId);
  const [doc, setDoc] = useOpenDoc();
  if (available === null) {
    return /* @__PURE__ */ jsx4(Frame, { profile, children: /* @__PURE__ */ jsx4("div", { "aria-busy": "true", style: { display: "grid", gap: 6, padding: pad }, children: [0, 1, 2].map((i) => /* @__PURE__ */ jsx4(Skeleton4, { style: { height: 18 } }, i)) }) });
  }
  if (available === false) {
    return /* @__PURE__ */ jsx4(Frame, { profile, children: /* @__PURE__ */ jsx4("p", { style: { ...muted4, fontSize: 13, padding: pad, maxWidth: 560, lineHeight: 1.5 }, children: S.notSetUp(profile) }) });
  }
  return /* @__PURE__ */ jsx4(PageBody, { doc, profile, setDoc }, `${connectionId ?? "local"}::${profile}`);
}
function PageBody({ profile, ...open }) {
  const roots = useRoots();
  if (roots.error) {
    return /* @__PURE__ */ jsx4(Frame, { profile, children: /* @__PURE__ */ jsx4(LoadError, { error: roots.error, onRetry: () => void roots.refetch() }) });
  }
  if (!roots.data) {
    return /* @__PURE__ */ jsx4(Frame, { profile, children: /* @__PURE__ */ jsx4("div", { "aria-busy": "true", style: { display: "grid", gap: 6, padding: pad }, children: [0, 1, 2].map((i) => /* @__PURE__ */ jsx4(Skeleton4, { style: { height: 18 } }, i)) }) });
  }
  if (roots.data.code === "no_roots") {
    return /* @__PURE__ */ jsx4(Frame, { profile, children: /* @__PURE__ */ jsx4(NoRoots, { reason: roots.data.reason }) });
  }
  if (roots.data.supported === false || roots.data.code === "unsupported_backend" || !roots.data.roots?.length) {
    return /* @__PURE__ */ jsx4(Frame, { profile, children: /* @__PURE__ */ jsx4(EmptyState3, { description: roots.data.reason ?? codeText(roots.data.code, roots.data.message), title: S.unsupportedTitle }) });
  }
  return /* @__PURE__ */ jsx4(Files, { profile, roots: roots.data, ...open });
}
function Frame({ children, profile, controls, onDropInput, dropLabel }) {
  const [over, setOver] = useState4(false);
  const depth = useRef4(0);
  const dragOver = (event) => {
    event.preventDefault();
    if (onDropInput) event.dataTransfer.dropEffect = "copy";
  };
  const drop = (event) => {
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    if (!onDropInput) return;
    const { entries, files } = collectDropEntries(event.dataTransfer);
    onDropInput(entries.length ? walkEntries(entries) : Promise.resolve(filesFromInput(files)), currentPin());
  };
  return /* @__PURE__ */ jsxs4(
    "section",
    {
      onDragEnter: (event) => {
        event.preventDefault();
        depth.current += 1;
        if (onDropInput && event.dataTransfer.types.includes("Files")) setOver(true);
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDragOver: dragOver,
      onDrop: drop,
      style: { position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0, color: "var(--ui-text-primary)" },
      children: [
        /* @__PURE__ */ jsxs4("header", { style: { display: "flex", alignItems: "center", gap: 10, padding: "18px 20px 10px" }, children: [
          /* @__PURE__ */ jsx4("h1", { style: { margin: 0, fontSize: 15, fontWeight: 600 }, children: S.title }),
          /* @__PURE__ */ jsx4("span", { style: { ...muted4, fontSize: 12 }, children: profile }),
          /* @__PURE__ */ jsx4("span", { style: { marginLeft: "auto" }, children: controls })
        ] }),
        children,
        over && /* @__PURE__ */ jsx4(
          "div",
          {
            style: {
              position: "absolute",
              inset: 8,
              display: "grid",
              placeItems: "center",
              border: "1.5px dashed var(--ui-accent)",
              borderRadius: 8,
              background: "color-mix(in srgb, var(--ui-accent) 8%, transparent)",
              color: "var(--ui-text-primary)",
              fontSize: 13,
              fontWeight: 500,
              pointerEvents: "none"
            },
            children: dropLabel
          }
        )
      ]
    }
  );
}
function Files({ profile, roots, doc, setDoc }) {
  const b = useBrowser(roots, "page");
  const guard = useLeaveGuard(doc);
  const queryClient = useQueryClient2();
  const [newFolder, setNewFolder] = useState4(false);
  const filesInput = useRef4(null);
  const folderInput = useRef4(null);
  const rootId = b.root?.id ?? "";
  const limits = { max_file_bytes: roots.max_file_bytes, chunk_bytes: roots.chunk_bytes };
  const here = baseName(b.path) || b.root?.label || "";
  const dest = { root: rootId, folder: b.path };
  const driveOn = useValue3($driveAvailable) === true;
  const [source, setSource] = useState4("cloud");
  const inDrive = driveOn && source === "drive";
  useEffect3(() => {
    if (!driveOn) setSource("cloud");
  }, [driveOn]);
  const only = b.selected.size === 1 ? [...b.selected.values()][0] : void 0;
  const openFile = (entry) => {
    if (!b.root || doc?.root === b.root.id && doc.path === entry.rel) return;
    const root = b.root;
    guard.leave(() => openDoc(entry, root, currentPin(), setDoc));
  };
  const docHere = () => Boolean(doc && doc.pin.connectionId === currentPin().connectionId && doc.pin.profile === currentPin().profile);
  const closeDoc = () => {
    const folder = doc && docHere() && doc.root === rootId ? parentPath(doc.path) : null;
    if (doc && folder !== null) requestFocus(b.focusNext, folder, doc.path);
    setDoc(null);
    if (folder !== null && (folder !== b.path || b.query)) b.navigate(folder);
  };
  const crumbTo = (path) => guard.leave(() => {
    const mine = docHere();
    if (mine && doc && doc.root !== rootId) b.switchRoot(doc.root);
    setDoc(null);
    if (mine) b.navigate(path);
  });
  const rootSelect = { ...b, switchRoot: (id) => guard.leave(() => (setDoc(null), b.switchRoot(id))) };
  const chooseSource = (drive) => drive ? guard.leave(() => (setDoc(null), setSource("drive"))) : setSource("cloud");
  const showImports = () => guard.leave(() => {
    setDoc(null);
    setSource("cloud");
    b.switchRoot(roots.roots[0].id);
    b.navigate(DRIVE_DEST);
  });
  const fromInput = (input) => {
    if (!input?.files) return;
    enqueueUpload(filesFromInput(input.files), dest, limits, currentPin());
    input.value = "";
  };
  const copyPaths = () => {
    const text = [...b.selected.keys()].join("\n");
    void pluginCtx().os.writeClipboard(text).then((ok) => ok, () => false).then((ok) => host3.notify(ok ? { kind: "success", message: S.copied(b.selected.size) } : { kind: "error", message: S.copyFailed }));
  };
  return /* @__PURE__ */ jsxs4(
    Frame,
    {
      controls: /* @__PURE__ */ jsx4(RootSelect, { b: rootSelect, drive: driveOn ? { active: inDrive, choose: chooseSource } : void 0 }),
      dropLabel: S.dropTo(here),
      onDropInput: (
        // No uploads while a file is open: the folder tools are hidden, and the shown folder is the file's.
        inDrive || doc ? void 0 : (pending, pin) => void pending.then(
          (input) => enqueueUpload(input, dest, limits, pin),
          (error) => host3.notify({ kind: "error", message: errorText(error) })
        )
      ),
      profile,
      children: [
        inDrive ? /* @__PURE__ */ jsx4(DrivePane, { roots }) : /* @__PURE__ */ jsxs4(Fragment2, { children: [
          /* @__PURE__ */ jsxs4("div", { style: toolbar, children: [
            doc ? /* @__PURE__ */ jsx4(Breadcrumbs, { b, folder: parentPath(doc.path), leaf: doc.name, onNavigate: crumbTo, rootLabel: doc.rootLabel }) : /* @__PURE__ */ jsxs4(Fragment2, { children: [
              /* @__PURE__ */ jsx4(Breadcrumbs, { b }),
              /* @__PURE__ */ jsx4(BrowserSearch, { b }),
              /* @__PURE__ */ jsx4(ToolButton, { icon: "new-folder", label: S.newFolder, onClick: () => setNewFolder(true) }),
              /* @__PURE__ */ jsx4(ToolButton, { icon: "cloud-upload", label: S.uploadFiles, onClick: () => filesInput.current?.click() }),
              /* @__PURE__ */ jsx4(ToolButton, { icon: "file-directory-create", label: S.uploadFolder, onClick: () => folderInput.current?.click() }),
              /* @__PURE__ */ jsx4(ToolButton, { disabled: !b.selected.size, icon: "copy", label: S.copyPath, onClick: copyPaths }),
              only && isEditable(only) && /* @__PURE__ */ jsx4(ToolButton, { icon: "go-to-file", label: S.open, onClick: () => openFile(only) })
            ] }),
            /* @__PURE__ */ jsx4("input", { hidden: true, multiple: true, onChange: (event) => fromInput(event.currentTarget), ref: filesInput, type: "file" }),
            /* @__PURE__ */ jsx4(
              "input",
              {
                hidden: true,
                multiple: true,
                onChange: (event) => fromInput(event.currentTarget),
                ref: folderInput,
                type: "file",
                ...{ webkitdirectory: "" }
              }
            )
          ] }),
          !doc && /* @__PURE__ */ jsx4("div", { style: { ...muted4, fontSize: 11, padding: "4px 20px", textAlign: "right" }, children: S.maxPerFile(roots.max_file_bytes) }),
          doc ? /* @__PURE__ */ jsx4(Editor, { doc, leave: guard.leave, onClose: closeDoc, setDoc }) : /* @__PURE__ */ jsx4(EntryList, { b, onOpenFile: openFile })
        ] }),
        /* @__PURE__ */ jsx4(ImportStatus, { onSettled: () => void queryClient.invalidateQueries({ queryKey: ["hcfm"] }), onShow: showImports }),
        guard.dialog,
        /* @__PURE__ */ jsx4(UploadDrawer, { onSettled: () => void queryClient.invalidateQueries({ queryKey: ["hcfm"] }) }),
        /* @__PURE__ */ jsx4(
          NewFolderDialog,
          {
            b,
            onCreated: () => void queryClient.invalidateQueries({ queryKey: ["hcfm"] }),
            onOpenChange: setNewFolder,
            open: newFolder
          }
        )
      ]
    }
  );
}
var toolbar = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "0 20px 8px", borderBottom: "1px solid var(--ui-stroke-tertiary)" };
function DrivePane({ roots }) {
  const d = useDriveBrowser();
  const job = useImport(useValue3($driveJob));
  const start = () => {
    const next = new DriveImport([...d.selected.values()], roots.roots[0].id, currentPin(), { rest, state: host3.state });
    $driveJob.set(next);
    d.clear();
    void next.start();
  };
  return /* @__PURE__ */ jsxs4(Fragment2, { children: [
    /* @__PURE__ */ jsxs4("div", { style: toolbar, children: [
      /* @__PURE__ */ jsx4(DriveCrumbs, { d }),
      /* @__PURE__ */ jsx4(BrowserSearch, { b: d, label: S.searchDrive }),
      /* @__PURE__ */ jsx4("span", { style: { ...muted4, fontSize: 11 }, children: S.importHint(roots.roots[0].label) }),
      /* @__PURE__ */ jsx4(
        ToolButton,
        {
          disabled: !d.selected.size || Boolean(job?.running),
          icon: "cloud-download",
          label: d.selected.size ? S.importCount(d.selected.size) : S.importToCloud,
          onClick: start
        }
      )
    ] }),
    /* @__PURE__ */ jsx4(DriveList, { d })
  ] });
}
function ImportStatus({ onShow, onSettled }) {
  const job = useValue3($driveJob);
  const snap = useImport(job);
  const profile = useValue3(host3.state.profile);
  const connectionId = useValue3(host3.state.connectionId);
  const wasRunning = useRef4(false);
  useEffect3(() => {
    if (wasRunning.current && !snap?.running) onSettled();
    wasRunning.current = Boolean(snap?.running);
  }, [snap?.running, onSettled]);
  if (!snap) return null;
  const here = snap.pin.profile === profile && snap.pin.connectionId === connectionId;
  if (!here && !snap.running) return null;
  return /* @__PURE__ */ jsxs4("div", { "aria-label": S.importToCloud, role: "region", style: { borderTop: "1px solid var(--ui-stroke-tertiary)", padding: "8px 20px", display: "grid", gap: 6 }, children: [
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 }, children: [
      /* @__PURE__ */ jsx4("span", { "aria-live": "polite", role: "status", style: { flex: 1, minWidth: 0 }, children: importStatus(snap) }),
      !snap.running && snap.imported.length > 0 && /* @__PURE__ */ jsx4(Button4, { onClick: onShow, size: "sm", variant: "text", children: S.show }),
      snap.running ? /* @__PURE__ */ jsx4(Button4, { disabled: snap.canceled, onClick: () => job?.cancel(), size: "sm", variant: "text", children: S.cancel }) : /* @__PURE__ */ jsx4(Button4, { onClick: () => $driveJob.set(null), size: "sm", variant: "text", children: S.clear })
    ] }),
    /* @__PURE__ */ jsx4(ImportFailures, { failures: snap.failures })
  ] });
}
function ToolButton({ icon, label, onClick, disabled }) {
  return /* @__PURE__ */ jsxs4(Button4, { disabled, onClick, size: "sm", variant: "ghost", children: [
    /* @__PURE__ */ jsx4(Codicon4, { name: icon, size: "0.875rem" }),
    label
  ] });
}
function NewFolderDialog({ b, open, onOpenChange, onCreated }) {
  const [name, setName] = useState4("");
  const [error, setError] = useState4("");
  const [busy, setBusy] = useState4(false);
  const errorId = useId();
  useEffect3(() => {
    if (open) {
      setName("");
      setError("");
    }
  }, [open]);
  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError(S.nameRequired);
    if (trimmed.includes("/")) return setError(S.nameNoSlash);
    setBusy(true);
    try {
      await call("/mkdir", { method: "POST", body: { root: b.root?.id, path: joinPath(b.path, trimmed) } });
      onOpenChange(false);
      onCreated();
      host3.notify({ kind: "success", message: S.folderCreated(trimmed) });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsx4(Dialog2, { onOpenChange, open, children: /* @__PURE__ */ jsx4(DialogContent2, { style: { maxWidth: 380 }, children: /* @__PURE__ */ jsxs4("form", { onSubmit: submit, style: { display: "grid", gap: 12 }, children: [
    /* @__PURE__ */ jsx4(DialogHeader2, { children: /* @__PURE__ */ jsx4(DialogTitle2, { children: S.newFolder }) }),
    /* @__PURE__ */ jsx4(
      Input,
      {
        "aria-describedby": error ? errorId : void 0,
        "aria-invalid": Boolean(error),
        "aria-label": S.folderName,
        autoFocus: true,
        onChange: (event) => setName(event.target.value),
        placeholder: S.folderName,
        value: name
      }
    ),
    error && /* @__PURE__ */ jsx4("div", { id: errorId, role: "alert", style: { color: "var(--ui-red)", fontSize: 12 }, children: error }),
    /* @__PURE__ */ jsxs4(DialogFooter2, { children: [
      /* @__PURE__ */ jsx4(Button4, { onClick: () => onOpenChange(false), type: "button", variant: "text", children: S.cancel }),
      /* @__PURE__ */ jsx4(Button4, { loading: busy, type: "submit", children: S.create })
    ] })
  ] }) }) });
}
var EMPTY = { profile: "", connectionId: null, items: [], running: false, paused: false, canceled: false };
var noop2 = () => () => void 0;
function useBatch(batch) {
  return useSyncExternalStore2(batch?.subscribe ?? noop2, batch?.getSnapshot ?? (() => EMPTY), batch?.getSnapshot ?? (() => EMPTY));
}
function Bar({ value, label, style }) {
  const pct = Math.round(Math.min(100, Math.max(0, value * 100)));
  return /* @__PURE__ */ jsx4(
    "div",
    {
      "aria-label": label,
      "aria-valuemax": 100,
      "aria-valuemin": 0,
      "aria-valuenow": pct,
      role: "progressbar",
      style: { height: 2, borderRadius: 2, background: "var(--ui-stroke-tertiary)", overflow: "hidden", ...style },
      children: /* @__PURE__ */ jsx4("div", { style: { height: "100%", width: `${pct}%`, background: "var(--ui-accent)", transition: "width 150ms" } })
    }
  );
}
function UploadDrawer({ onSettled }) {
  const batch = useValue3($batch);
  const snap = useBatch(batch);
  const [collapsed, setCollapsed] = useState4(false);
  const wasRunning = useRef4(false);
  useEffect3(() => {
    if (wasRunning.current && !snap.running) onSettled();
    wasRunning.current = snap.running;
  }, [snap.running, onSettled]);
  if (!batch || !snap.items.length) return null;
  const sum = summarize(snap);
  const headline = snap.canceled ? S.canceled : snap.paused ? S.paused(snap.profile) : snap.running ? S.uploading(Math.min(sum.total, sum.settled + 1), sum.total, humanSize(sum.sent), humanSize(sum.size)) : S.uploaded(sum.done, sum.total, sum.failed);
  return /* @__PURE__ */ jsxs4("div", { "aria-label": S.uploads, role: "region", style: { borderTop: "1px solid var(--ui-stroke-tertiary)", padding: "8px 20px", display: "grid", gap: 6 }, children: [
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 }, children: [
      /* @__PURE__ */ jsx4(Button4, { "aria-label": collapsed ? S.expand : S.collapse, onClick: () => setCollapsed(!collapsed), size: "icon-xs", variant: "ghost", children: /* @__PURE__ */ jsx4(Codicon4, { name: collapsed ? "chevron-up" : "chevron-down", size: "0.875rem" }) }),
      /* @__PURE__ */ jsx4("span", { "aria-live": "polite", role: "status", style: { flex: 1, minWidth: 0 }, children: headline }),
      snap.running ? /* @__PURE__ */ jsx4(Button4, { onClick: () => batch.cancel(), size: "sm", variant: "text", children: S.cancel }) : /* @__PURE__ */ jsx4(Button4, { onClick: () => $batch.set(null), size: "sm", variant: "text", children: S.clear })
    ] }),
    snap.running && /* @__PURE__ */ jsx4(Bar, { label: S.uploadProgress, value: sum.size ? sum.sent / sum.size : sum.total ? sum.settled / sum.total : 0 }),
    !collapsed && /* @__PURE__ */ jsx4("div", { style: { maxHeight: 180, overflowY: "auto", display: "grid", gap: 4 }, children: snap.items.map((item) => /* @__PURE__ */ jsx4(UploadRow, { item, onRetry: () => batch.retry(item.id) }, item.id)) })
  ] });
}
function statusText(item) {
  if (item.status === "queued") return S.queued;
  if (item.status === "uploading") return `${item.size ? Math.floor(item.sent / item.size * 100) : 0}%`;
  if (item.status === "canceled") return S.canceledItem;
  if (item.status === "failed") return S.failed(item.error ?? "");
  return item.savedAs ? S.savedAs(item.savedAs) : S.done;
}
function UploadRow({ item, onRetry }) {
  return /* @__PURE__ */ jsxs4("div", { "data-upload": item.path, style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "2px 8px", alignItems: "center", fontSize: 11 }, children: [
    /* @__PURE__ */ jsx4("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: item.path }),
    /* @__PURE__ */ jsxs4("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, color: item.status === "failed" ? "var(--ui-red)" : "var(--ui-text-tertiary)" }, children: [
      statusText(item),
      item.status === "failed" && item.retryable !== false && /* @__PURE__ */ jsx4(Button4, { onClick: onRetry, size: "micro", variant: "textStrong", children: S.retry })
    ] }),
    item.status === "uploading" && /* @__PURE__ */ jsx4(Bar, { label: S.uploadProgressOf(item.path), style: { gridColumn: "1 / -1", marginTop: 3 }, value: item.size ? item.sent / item.size : 0 })
  ] });
}

// src/desktop/picker.tsx
import {
  atom as atom6,
  Button as Button5,
  Dialog as Dialog3,
  DialogContent as DialogContent3,
  DialogFooter as DialogFooter3,
  DialogHeader as DialogHeader3,
  DialogTitle as DialogTitle3,
  EmptyState as EmptyState4,
  host as host4,
  useValue as useValue4
} from "@hermes/plugin-sdk";
import { useEffect as useEffect4, useRef as useRef5 } from "react";
import { Fragment as Fragment3, jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
var $pickerOpen = atom6(false);
var $insertText = atom6(null);
var $hostClaim = atom6(null);
var $pickerSource = atom6("cloud");
var $pickerJob = atom6(null);
var NO_OWNER = atom6(null);
var $finished = atom6(null);
var NO_SESSION = atom6(null);
var focusedOwner = () => (host4.state.focusedSessionOwner ?? NO_OWNER).get();
var pinReady = (pin) => host4.state.profile.get() === pin.profile && host4.state.connectionId.get() === pin.connectionId && !ownerMismatch(focusedOwner(), pin.connectionId, pin.profile);
var $touched = atom6(false);
var openPin = null;
var stopWatching = () => void 0;
function pickerPinnedElsewhere() {
  return $pickerOpen.get() && openPin !== null && (openPin.profile !== host4.state.profile.get() || openPin.connectionId !== host4.state.connectionId.get());
}
var pickerPinProfile = () => openPin?.profile;
function watchOpen() {
  unwatch();
  const { connectionId, profile } = host4.state;
  openPin = { connectionId: connectionId.get(), profile: profile.get() };
  $touched.set(false);
  const touch = () => $touched.set(true);
  const atoms = [profile, connectionId, host4.state.focusedSessionOwner ?? NO_OWNER, host4.state.activeSessionId ?? NO_SESSION];
  const stops = atoms.map((store) => store.listen(touch));
  stopWatching = () => stops.forEach((stop) => stop());
}
function unwatch() {
  stopWatching();
  stopWatching = () => void 0;
  openPin = null;
}
var canInsert = (pin) => Boolean(pin) && !$touched.get() && pinReady(pin);
function copyLocations(text) {
  void pluginCtx().os.writeClipboard(text).then((ok) => ok, () => false).then((ok) => host4.notify(ok ? { kind: "success", message: S.locationsCopied } : { kind: "error", message: S.copyFailed }));
}
var ownerHold = (pin) => ({
  held: () => ownerMismatch(focusedOwner(), pin.connectionId, pin.profile),
  subscribe: (wake) => (host4.state.focusedSessionOwner ?? NO_OWNER).subscribe(wake)
});
function openPicker(insertText, source) {
  stopImport();
  $insertText.set(insertText);
  $pickerSource.set(source);
  watchOpen();
  $pickerOpen.set(true);
}
var cloudProvider = {
  label: S.providerLabel,
  icon: "cloud",
  run(ctx) {
    openPicker(ctx.insertText, "cloud");
  }
};
var driveProvider = {
  label: S.drive,
  icon: "cloud-download",
  run(ctx) {
    openPicker(ctx.insertText, "drive");
  }
};
function ownerMismatch(owner, connectionId, profile) {
  if (!owner) return false;
  const id = (value) => String(value ?? "").trim() || null;
  return (owner.profile || "default") !== (profile || "default") || id(owner.connectionId) !== id(connectionId);
}
function PickerHost() {
  const me = useRef5({}).current;
  const claim = useValue4($hostClaim);
  const open = useValue4($pickerOpen);
  useEffect4(() => {
    const tryClaim = () => {
      if ($hostClaim.get() === null) $hostClaim.set(me);
    };
    tryClaim();
    const stop = $hostClaim.subscribe(tryClaim);
    return () => {
      stop();
      if ($hostClaim.get() === me) $hostClaim.set(null);
      if ($hostClaim.get() === null) closePicker();
    };
  }, [me]);
  if (claim !== me || !open) return null;
  return /* @__PURE__ */ jsx5(PickerDialog, {});
}
function stopImport() {
  $pickerJob.get()?.cancel();
  $pickerJob.set(null);
  $finished.set(null);
}
function closePicker() {
  stopImport();
  unwatch();
  $pickerOpen.set(false);
  $pickState.set(null);
  $insertText.set(null);
}
function PickerDialog() {
  const profile = useValue4(host4.state.profile);
  const connectionId = useValue4(host4.state.connectionId);
  const owner = useValue4(host4.state.focusedSessionOwner ?? NO_OWNER);
  const mismatch = ownerMismatch(owner, connectionId, profile);
  const source = useValue4($pickerSource);
  const finished = useValue4($finished);
  const job = useImport(useValue4($pickerJob));
  const available = useValue4($available);
  const driveAvailable = useValue4($driveAvailable);
  const unavailable = available === false || source === "drive" && driveAvailable === false;
  const pending = available === null || source === "drive" && driveAvailable !== true && driveAvailable !== false;
  const notice = finished ? S.importedTo(finished.pin.profile) : !pending && unavailable && pickerPinnedElsewhere() ? (source === "drive" ? S.drivePinnedElsewhere : S.pickerPinnedElsewhere)(profile, pickerPinProfile()) : mismatch && !pending ? S.ownerMismatch(owner.profile, profile) : null;
  return /* @__PURE__ */ jsx5(Dialog3, { onOpenChange: (next) => !next && closePicker(), open: true, children: /* @__PURE__ */ jsxs5(DialogContent3, { style: { maxWidth: 720, width: "92vw" }, children: [
    /* @__PURE__ */ jsx5(DialogHeader3, { children: /* @__PURE__ */ jsx5(DialogTitle3, { children: source === "drive" ? S.drivePickerTitle : S.pickerTitle }) }),
    notice ? /* @__PURE__ */ jsxs5(Fragment3, { children: [
      /* @__PURE__ */ jsx5("p", { style: { fontSize: 13, color: "var(--ui-text-secondary)", lineHeight: 1.5 }, children: notice }),
      finished && job && /* @__PURE__ */ jsx5(ImportFailures, { failures: job.failures })
    ] }) : pending || unavailable ? /* @__PURE__ */ jsx5("div", { "aria-busy": "true", style: { height: 360 } }) : /* @__PURE__ */ jsx5(PickerBody, { profile, source }, `${connectionId ?? "local"}::${profile}`),
    notice && /* @__PURE__ */ jsxs5(DialogFooter3, { children: [
      /* @__PURE__ */ jsx5(Button5, { onClick: closePicker, variant: "text", children: S.cancel }),
      finished && /* @__PURE__ */ jsx5(Button5, { onClick: () => copyLocations(finished.text), children: S.copyLocations })
    ] })
  ] }) });
}
function PickerBody({ profile, source }) {
  const roots = useRoots();
  if (roots.error) return /* @__PURE__ */ jsx5(LoadError, { error: roots.error, onRetry: () => void roots.refetch() });
  if (roots.data?.code === "no_roots") return /* @__PURE__ */ jsx5(NoRoots, { onOpenSettings: closePicker, reason: roots.data.reason });
  if (roots.data && (roots.data.supported === false || !roots.data.roots?.length)) {
    return /* @__PURE__ */ jsx5(EmptyState4, { description: roots.data.reason, title: S.unsupportedTitle });
  }
  if (!roots.data) return /* @__PURE__ */ jsx5("div", { "aria-busy": "true", style: { height: 360 } });
  if (source === "drive") return /* @__PURE__ */ jsx5(DrivePicker, { roots: roots.data });
  return /* @__PURE__ */ jsx5(PickerBrowser, { profile, roots: roots.data });
}
function PickerBrowser({ profile, roots }) {
  const b = useBrowser(roots, "pick");
  const touched = useValue4($touched);
  const insertable = [...b.selected.values()].filter((entry) => !hasLineBreak(entry.abs));
  const skipped = b.selected.size - insertable.length;
  const text = () => formatInsertText(profile, insertable);
  const insert = () => {
    if (!canInsert(openPin)) return;
    $insertText.get()?.(text());
    closePicker();
  };
  return /* @__PURE__ */ jsxs5("div", { style: { display: "grid", gap: 8, minWidth: 0 }, children: [
    /* @__PURE__ */ jsxs5("div", { style: { display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--ui-stroke-tertiary)", paddingBottom: 6 }, children: [
      /* @__PURE__ */ jsx5(Breadcrumbs, { b }),
      /* @__PURE__ */ jsx5(BrowserSearch, { b }),
      /* @__PURE__ */ jsx5(RootSelect, { b })
    ] }),
    /* @__PURE__ */ jsx5(EntryList, { b, height: 360 }),
    touched && /* @__PURE__ */ jsx5("div", { style: { fontSize: 12, color: "var(--ui-text-secondary)" }, children: S.chatChanged }),
    /* @__PURE__ */ jsxs5(DialogFooter3, { style: { alignItems: "center" }, children: [
      /* @__PURE__ */ jsx5("span", { "aria-live": "polite", role: "status", style: { marginRight: "auto", fontSize: 12, color: "var(--ui-text-tertiary)" }, children: S.selected(b.selected.size) }),
      skipped > 0 && /* @__PURE__ */ jsx5("span", { style: { fontSize: 12, color: "var(--ui-text-secondary)" }, children: S.lineBreakSkipped(skipped) }),
      /* @__PURE__ */ jsx5(Button5, { onClick: closePicker, variant: "text", children: S.cancel }),
      touched ? /* @__PURE__ */ jsx5(Button5, { disabled: !insertable.length, onClick: () => copyLocations(text()), children: S.copyLocations }) : /* @__PURE__ */ jsx5(Button5, { disabled: !insertable.length, onClick: insert, children: S.insert })
    ] })
  ] });
}
function DrivePicker({ roots }) {
  const d = useDriveBrowser();
  const snap = useImport(useValue4($pickerJob));
  const start = () => {
    const insertText = $insertText.get();
    const pin = currentPin();
    const job = new DriveImport([...d.selected.values()], roots.roots[0].id, pin, { rest, state: host4.state, hold: ownerHold(pin) });
    $pickerJob.set(job);
    void job.start().then((done) => {
      if (done.canceled || $pickerJob.get() !== job || !done.imported.length) return;
      const text = formatInsertText(pin.profile, done.imported);
      if (!canInsert(pin)) return $finished.set({ pin, text });
      insertText?.(text);
      if (!done.failures.length) closePicker();
    });
  };
  return /* @__PURE__ */ jsxs5("div", { style: { display: "grid", gap: 8, minWidth: 0 }, children: [
    /* @__PURE__ */ jsxs5("div", { style: { display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--ui-stroke-tertiary)", paddingBottom: 6 }, children: [
      /* @__PURE__ */ jsx5(DriveCrumbs, { d }),
      /* @__PURE__ */ jsx5(BrowserSearch, { b: d, label: S.searchDrive })
    ] }),
    /* @__PURE__ */ jsx5(DriveList, { d, height: 360 }),
    snap && /* @__PURE__ */ jsx5(ImportFailures, { failures: snap.failures }),
    /* @__PURE__ */ jsxs5(DialogFooter3, { style: { alignItems: "center" }, children: [
      /* @__PURE__ */ jsx5("span", { "aria-live": "polite", role: "status", style: { marginRight: "auto", fontSize: 12, color: "var(--ui-text-tertiary)" }, children: snap ? importStatus(snap) : S.selected(d.selected.size) }),
      snap && !snap.running ? /* @__PURE__ */ jsx5(Button5, { onClick: closePicker, children: S.close }) : /* @__PURE__ */ jsxs5(Fragment3, { children: [
        /* @__PURE__ */ jsx5(Button5, { onClick: closePicker, variant: "text", children: S.cancel }),
        /* @__PURE__ */ jsx5(Button5, { disabled: !d.selected.size, loading: Boolean(snap), onClick: start, children: S.importAndInsert })
      ] })
    ] })
  ] });
}

// src/desktop/plugin.tsx
import { jsx as jsx6 } from "react/jsx-runtime";
var PLUGIN_ID = "hermes-cloud-file-manager";
var PAGE_PATH = "/cloud-files";
var PROBE_INTERVAL_MS = 6e4;
function registerAvailabilityGate(ctx, onChange) {
  let removers = null;
  let pickerRemover = null;
  let known = null;
  let disposed = false;
  let driveRemover = null;
  const setDrive = (available) => {
    if (disposed) return;
    if ($driveAvailable.get() !== available) $driveAvailable.set(available);
    if (!available && $pickerOpen.get() && $pickerSource.get() === "drive" && !pickerPinnedElsewhere()) closePicker();
    if (available && !driveRemover) {
      driveRemover = ctx.register({ id: "attach-drive", area: COMPOSER_AREAS.attachments, data: driveProvider });
    } else if (!available && driveRemover) {
      driveRemover();
      driveRemover = null;
    }
  };
  const set = (available) => {
    if (disposed) return;
    if (available === false) setDrive(false);
    if (available !== known) {
      known = available;
      onChange?.(available);
    }
    if (available && !removers) {
      removers = [
        ctx.register({
          id: "nav",
          area: SIDEBAR_NAV_AREA,
          order: 45,
          data: { codicon: "cloud", label: S.navLabel, path: PAGE_PATH }
        }),
        ctx.register({ id: "attach-cloud", area: COMPOSER_AREAS.attachments, data: cloudProvider })
      ];
    } else if (!available && removers) {
      removers.forEach((remove) => remove());
      removers = null;
    }
    if (available && !pickerRemover) {
      pickerRemover = ctx.register({ id: "picker-host", area: COMPOSER_AREAS.underside, render: () => /* @__PURE__ */ jsx6(PickerHost, {}) });
    } else if (available === false && !pickerPinnedElsewhere()) {
      closePicker();
      pickerRemover?.();
      pickerRemover = null;
    }
  };
  let generation2 = 0;
  const probe = () => {
    const mine = ++generation2;
    return ctx.rest("/available").then(
      () => {
        if (mine !== generation2 || disposed) return;
        set(true);
        return ctx.rest("/drive/available").then(
          (res) => {
            if (mine === generation2) setDrive(res?.available === true);
          },
          (error) => {
            if (mine === generation2 && isNotFoundError(error)) setDrive(false);
          }
        );
      },
      (error) => {
        if (mine === generation2 && isNotFoundError(error)) set(false);
      }
    );
  };
  void probe();
  ctx.setInterval(() => void probe(), PROBE_INTERVAL_MS);
  const onAgentChange = () => {
    if (!disposed) {
      set(null);
      if ($driveAvailable.get() === true) $driveAvailable.set(null);
      driveRemover?.();
      driveRemover = null;
    }
    void probe();
  };
  const unsubscribers = [
    host5.state.profile.listen(onAgentChange),
    host5.state.connectionId.listen(onAgentChange),
    $pickerOpen.listen((open) => {
      if (!open && known === false && !disposed) {
        pickerRemover?.();
        pickerRemover = null;
      }
    })
  ];
  ctx.onDispose(() => {
    disposed = true;
    unsubscribers.forEach((stop) => stop());
    closePicker();
    $batch.get()?.cancel();
    $batch.set(null);
    $driveJob.get()?.cancel();
    $driveJob.set(null);
  });
  return { probe };
}
var plugin = {
  id: PLUGIN_ID,
  name: "Cloud File Manager",
  description: "Browse, search, upload and edit files on the machine your agent runs on, and hand the agent file locations from the chat + menu.",
  register(ctx) {
    bindContext(ctx);
    ctx.register({
      id: "page",
      area: ROUTES_AREA,
      data: { path: PAGE_PATH },
      render: () => /* @__PURE__ */ jsx6(CloudFilesPage, {})
    });
    registerAvailabilityGate(ctx, (available) => $available.set(available));
  }
};
var plugin_default = plugin;
export {
  PAGE_PATH,
  PLUGIN_ID,
  plugin_default as default,
  isNotFoundError,
  registerAvailabilityGate
};
