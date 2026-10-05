// Generated from src/desktop by scripts/build-desktop.mjs. Do not edit by hand.

// src/desktop/plugin.tsx
import {
  host as host4,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  useValue as useValue3
} from "@hermes/plugin-sdk";

// src/desktop/audio.ts
import { atom } from "@hermes/plugin-sdk";
var $playing = atom(null);
var element = null;
var objectUrl = null;
function base64ToBlob(data, mime) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
function play(key, data, mime) {
  stop();
  objectUrl = URL.createObjectURL(base64ToBlob(data, mime));
  const audio = new Audio(objectUrl);
  element = audio;
  audio.onended = () => stop(key);
  $playing.set(key);
  void audio.play().catch(() => stop(key));
}
var epoch = 0;
var playbackEpoch = () => epoch;
function releasePlayback() {
  epoch++;
  stop();
}
function stop(key) {
  if (key !== void 0 && $playing.get() !== key) return;
  element?.pause();
  element = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  if ($playing.get() !== null) $playing.set(null);
}
var previews = /* @__PURE__ */ new Map();
function cachedPreview(key) {
  return previews.get(key);
}
function rememberPreview(key, value) {
  previews.delete(key);
  previews.set(key, value);
  while (previews.size > 24) previews.delete(previews.keys().next().value);
}

// src/desktop/api.ts
import { atom as atom2, host } from "@hermes/plugin-sdk";
var $available = atom2(null);
var $account = atom2(null);
var $availableError = atom2(null);
var agentEpoch = 0;
var currentAgentEpoch = () => agentEpoch;
var endAgentOperations = () => {
  agentEpoch++;
};
var $tab = atom2("library");
var ApiError = class extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
  kind;
};
var bound = null;
var refresher = null;
function setRefresher(probe) {
  refresher = probe;
}
var refreshAvailability = () => refresher?.(true);
function bindContext(ctx) {
  bound = ctx;
}
function pluginCtx() {
  if (!bound) throw new Error("Fish Audio is not registered");
  return bound;
}
async function call(path, opts) {
  const res = await pluginCtx().rest(path, opts);
  if (res && res.ok === false) throw new ApiError(res.kind ?? "error", res.message ?? "Something went wrong");
  return res;
}
var post = (path, body, timeoutMs = 6e4) => call(path, { method: "POST", body, timeoutMs });
var query = (path, params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== void 0 && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `${path}?${text}` : path;
};
function isNotFoundError(error) {
  return httpStatus(error) === 404;
}
function httpStatus(error) {
  const text = error instanceof Error ? error.message : String(error);
  const match = /^\s*(\d{3}):/.exec(text) ?? /Error: (\d{3}):/.exec(text);
  return match ? Number(match[1]) : null;
}
var errorText = (error) => error instanceof Error ? error.message : String(error);
var currentPin = () => ({ connectionId: host.state.connectionId.get(), profile: host.state.profile.get() });
var samePin = (a, b) => a.connectionId === b.connectionId && a.profile === b.profile;
var agentKey = (pin) => `${pin.connectionId ?? "local"}::${pin.profile}`;

// src/desktop/page.tsx
import {
  atom as atom3,
  Badge,
  Button as Button3,
  Codicon as Codicon3,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState as ErrorState2,
  host as host3,
  Input as Input2,
  SearchField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SegmentedControl,
  useQuery,
  useQueryClient as useQueryClient2,
  useValue as useValue2
} from "@hermes/plugin-sdk";
import { useEffect, useState as useState2 } from "react";

// src/desktop/create.tsx
import { Button as Button2, Checkbox, Codicon as Codicon2, host as host2, Input, Textarea, useQueryClient, useValue } from "@hermes/plugin-sdk";
import { useRef, useState } from "react";

// src/desktop/strings.ts
var agentName = (profile) => profile && profile !== "default" ? profile : "this agent";
var LINKS = {
  keys: "https://fish.audio/app/api-keys",
  discovery: "https://fish.audio/discovery"
};
var S = {
  title: "Voices",
  navLabel: "Voices",
  paletteVoices: "Fish Audio: Voices",
  paletteAccount: "Fish Audio: Account",
  poweredBy: "Fish Audio",
  forAgent: (profile) => `For ${agentName(profile)}`,
  notSetUp: (profile) => `Fish Audio isn't set up on ${agentName(profile)}'s machine yet. Install the plugin there, enable it, and restart the gateway.`,
  tabs: { library: "Library", mine: "My voices", create: "Create", account: "Account" },
  // Onboarding (no key)
  onboardTitle: "Connect your Fish Audio account",
  onboardBody: (profile) => `Voices need a Fish Audio API key on ${agentName(profile)}. New accounts can start on the free s2.1-pro-free model.`,
  onboardStep1: "Create a free API key on fish.audio",
  onboardStep2: "Paste it in Plugins \u25B8 Fish Audio, then restart the gateway",
  getKey: "Get an API key",
  openPlugins: "Open Plugins",
  checkAgain: "Check again",
  unreachable: (profile) => `Couldn't reach Fish Audio on ${agentName(profile)}`,
  // Library
  search: "Search voices",
  language: "Language",
  anyLanguage: "Any language",
  favouritesOnly: "Favourites",
  billedNote: "Preview plays a short sample and is billed to your Fish Audio account.",
  preview: "Preview",
  stop: "Stop",
  use: "Use",
  inUse: "In use",
  favourite: "Favourite",
  unfavourite: "Remove favourite",
  uses: (n) => `${compact(n)} uses`,
  noVoices: "No voices match",
  noFavourites: "No favourites yet",
  noFavouritesHint: "Star a voice in the library to keep it here.",
  prev: "Previous",
  next: "Next",
  pageOf: (page) => `Page ${page}`,
  usedVoice: (title, profile) => `${title} is now ${agentName(profile)}'s voice`,
  loadFailed: "Couldn't load voices",
  retry: "Retry",
  // My voices
  mineEmpty: "You haven't created any voices yet",
  mineEmptyHint: "Clone your voice or design a new one in Create.",
  delete: "Delete",
  deleteTitle: (title) => `Delete "${title}"?`,
  deleteBody: "This removes the voice from your Fish Audio account. Agents using this voice will need another voice selected.",
  deleteConfirmLabel: (title) => `Type "${title}" to confirm`,
  cancel: "Cancel",
  deleted: (title) => `Deleted ${title}`,
  // Create
  cloneTitle: "Clone a voice",
  cloneBody: "Upload 1\u20133 clear recordings of one speaker (MP3, WAV, OGG, WebM, FLAC or MP4, up to 10 MB each).",
  chooseFiles: "Choose audio files",
  voiceTitle: "Voice name",
  descriptionOptional: "Description (optional)",
  consent: "I have the speaker's permission to clone this voice.",
  clone: "Clone voice",
  cloneBilled: "Cloning is billed to your Fish Audio account.",
  uploading: (n, total, percent) => `Uploading ${n} of ${total} \xB7 ${percent}%`,
  cloning: "Creating the voice\u2026",
  cloned: (title) => `Created ${title}. Find it in My voices.`,
  tooMany: "Choose up to 3 files.",
  tooLarge: (name) => `${name} is larger than 10 MB.`,
  agentChangedNothingSent: "The selected agent changed, so nothing was sent.",
  agentChanged: "The selected agent changed, so the upload stopped. Nothing was sent to the other agent.",
  designTitle: "Design a voice",
  designBody: "Describe the voice you want. Fish Audio makes a few candidates to choose from.",
  designPlaceholder: "A warm, unhurried British narrator in her forties, slightly husky",
  design: "Design voices",
  designing: "Designing\u2026",
  designBilled: "Each design is billed to your Fish Audio account.",
  candidate: (n) => `Candidate ${n}`,
  saveAs: "Name",
  save: "Save voice",
  saved: (title) => `Saved ${title}. Find it in My voices.`,
  // Account
  apiCredit: "API credit",
  lowCredit: "Low balance \u2014 top up to keep voice replies working.",
  topUps: "Lifetime top-ups",
  freeCredit: "Free credit available",
  plan: "Plan",
  planBalance: (balance, total) => `${balance.toLocaleString()} of ${total.toLocaleString()} credits left`,
  renews: (date) => `Renews ${date}`,
  periodEnds: (date) => `Current period ends ${date}`,
  noPlan: "No app plan",
  planUnavailable: "Plan details are unavailable right now.",
  creditsSeparate: "App plan credits and API credits are separate. Voice replies use API credit.",
  topUp: "Top up API credit",
  plans: "Plans",
  apiKeys: "API keys",
  chip: (credit) => `Fish ${credit}`,
  chipTip: "Fish Audio API credit",
  usd: (value) => `$${Number(value).toFixed(2)}`
};
function compact(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
var LANGUAGES = [
  ["en", "English"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ru", "Russian"],
  ["ar", "Arabic"],
  ["nl", "Dutch"],
  ["pl", "Polish"]
];

// src/desktop/ui.tsx
import { Button, Codicon, ErrorState, Skeleton } from "@hermes/plugin-sdk";
import { jsx, jsxs } from "react/jsx-runtime";
var muted = { color: "var(--ui-text-tertiary)" };
var card = {
  background: "var(--ui-bg-card)",
  border: "1px solid var(--ui-stroke-tertiary)",
  borderRadius: 6,
  padding: 16
};
function Rows({ n = 4 }) {
  return /* @__PURE__ */ jsx("div", { "aria-busy": "true", style: { display: "grid", gap: 10, padding: "0 24px" }, children: Array.from({ length: n }, (_, i) => /* @__PURE__ */ jsx(Skeleton, { style: { height: 44 } }, i)) });
}
function BilledNote({ text }) {
  return /* @__PURE__ */ jsxs("p", { style: { ...muted, alignItems: "center", display: "flex", fontSize: 12, gap: 6, margin: 0 }, children: [
    /* @__PURE__ */ jsx(Codicon, { name: "info" }),
    text
  ] });
}
function LoadError({ error, onRetry }) {
  return /* @__PURE__ */ jsx(ErrorState, { description: errorText(error), title: S.loadFailed, children: /* @__PURE__ */ jsx(Button, { onClick: onRetry, size: "xs", variant: "secondary", children: S.retry }) });
}

// src/desktop/upload.ts
var MAX_FILES = 3;
var MAX_FILE_BYTES = 10 * 1024 * 1024;
var AgentChanged = class extends Error {
  constructor() {
    super("agent changed");
  }
};
var readChunk = async (slice) => bytesToBase64(new Uint8Array(await slice.arrayBuffer()));
async function cloneVoice(files, meta, pin, deps, onProgress) {
  const read = deps.readChunk ?? readChunk;
  const epoch2 = deps.epoch?.();
  const still = () => samePin(deps.current(), pin) && deps.epoch?.() === epoch2;
  const send = (path, body, timeoutMs) => {
    if (!still()) throw new AgentChanged();
    return deps.rest(path, { method: "POST", body, timeoutMs }).then((res) => {
      if (!still()) throw new AgentChanged();
      if (res && res.ok === false) throw new ApiError(res.kind ?? "error", res.message ?? "Something went wrong");
      return res;
    });
  };
  const uploaded = [];
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let sent = 0;
  let finishing = false;
  try {
    for (const [index, file] of files.entries()) {
      const start = await send("/clone/start", { size: file.size }, 3e4);
      uploaded.push({ upload_id: start.upload_id, size: file.size });
      if (!Number.isInteger(start.chunk_bytes) || start.chunk_bytes <= 0) throw new ApiError("error", "The gateway sent an invalid upload chunk size.");
      for (let offset = 0; offset < file.size; offset += start.chunk_bytes) {
        const data = await read(file.slice(offset, offset + start.chunk_bytes));
        await send("/clone/chunk", { upload_id: start.upload_id, offset, data }, 12e4);
        if (!still()) throw new AgentChanged();
        sent += Math.min(start.chunk_bytes, file.size - offset);
        onProgress?.(index + 1, sent, total);
      }
    }
    finishing = true;
    const done = await send(
      "/clone/finish",
      { files: uploaded, title: meta.title, description: meta.description || void 0, consent: meta.consent },
      6e5
    );
    return done.voice;
  } catch (error) {
    if (!finishing && still()) {
      for (const item of uploaded) {
        void deps.rest("/clone/abort", { method: "POST", body: { upload_id: item.upload_id } }).catch(() => void 0);
      }
    }
    throw error;
  }
}

// src/desktop/create.tsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var label = { display: "grid", fontSize: 12, gap: 6 };
function CreateTab({ pin }) {
  return /* @__PURE__ */ jsxs2("div", { style: { display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", padding: "0 24px" }, children: [
    /* @__PURE__ */ jsx2(DesignCard, { pin }),
    /* @__PURE__ */ jsx2(CloneCard, { pin })
  ] });
}
function CloneCard({ pin }) {
  const client = useQueryClient();
  const input = useRef(null);
  const [files, setFiles] = useState([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const pick = (event) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = "";
    const tooBig = chosen.find((file) => file.size > MAX_FILE_BYTES);
    if (chosen.length > MAX_FILES) return setStatus(S.tooMany);
    if (tooBig) return setStatus(S.tooLarge(tooBig.name));
    setStatus(null);
    setFiles(chosen);
  };
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    if (!samePin(currentPin(), pin)) return setStatus(S.agentChangedNothingSent);
    inFlight.current = true;
    setBusy(true);
    try {
      const voice = await cloneVoice(
        files,
        { consent, description: description.trim(), title: title.trim() },
        pin,
        { current: currentPin, epoch: currentAgentEpoch, rest: (path, opts) => pluginCtx().rest(path, opts) },
        (n, sent, total) => setStatus(S.uploading(n, files.length, Math.round(sent / Math.max(1, total) * 100)))
      );
      if (!samePin(currentPin(), pin)) return;
      setStatus(S.cloned(voice.title));
      setFiles([]);
      setTitle("");
      setDescription("");
      setConsent(false);
      void client.invalidateQueries({ queryKey: ["fish-audio", agentKey(pin), "mine"] });
      void refreshAvailability();
    } catch (error) {
      if (!samePin(currentPin(), pin)) return;
      setStatus(error instanceof AgentChanged ? S.agentChanged : errorText(error));
    } finally {
      inFlight.current = false;
      if (samePin(currentPin(), pin)) setBusy(false);
    }
  };
  const ready = files.length > 0 && title.trim().length > 0 && consent && !busy;
  return /* @__PURE__ */ jsxs2("section", { style: card, children: [
    /* @__PURE__ */ jsx2("h2", { style: { fontSize: 15, fontWeight: 600, margin: "0 0 4px" }, children: S.cloneTitle }),
    /* @__PURE__ */ jsx2("p", { style: { ...muted, fontSize: 12, lineHeight: 1.5, margin: "0 0 12px" }, children: S.cloneBody }),
    /* @__PURE__ */ jsxs2("div", { style: { display: "grid", gap: 10 }, children: [
      /* @__PURE__ */ jsx2("input", { accept: "audio/*,.mp3,.wav,.ogg,.webm,.flac,.m4a,.mp4", hidden: true, multiple: true, onChange: pick, ref: input, type: "file" }),
      /* @__PURE__ */ jsxs2("div", { style: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }, children: [
        /* @__PURE__ */ jsxs2(Button2, { disabled: busy, onClick: () => input.current?.click(), size: "xs", variant: "secondary", children: [
          /* @__PURE__ */ jsx2(Codicon2, { name: "cloud-upload" }),
          S.chooseFiles
        ] }),
        /* @__PURE__ */ jsx2("span", { style: { ...muted, fontSize: 12 }, children: files.map((file) => file.name).join(", ") })
      ] }),
      /* @__PURE__ */ jsxs2("label", { style: label, children: [
        S.voiceTitle,
        /* @__PURE__ */ jsx2(Input, { disabled: busy, onChange: (e) => setTitle(e.target.value), value: title })
      ] }),
      /* @__PURE__ */ jsxs2("label", { style: label, children: [
        S.descriptionOptional,
        /* @__PURE__ */ jsx2(Input, { disabled: busy, onChange: (e) => setDescription(e.target.value), value: description })
      ] }),
      /* @__PURE__ */ jsxs2("label", { style: { alignItems: "flex-start", display: "flex", fontSize: 12, gap: 8, lineHeight: 1.4 }, children: [
        /* @__PURE__ */ jsx2(
          Checkbox,
          {
            "aria-label": S.consent,
            checked: consent,
            disabled: busy,
            onCheckedChange: (value) => setConsent(value === true),
            style: consent ? void 0 : { borderColor: "var(--ui-text-tertiary)" }
          }
        ),
        /* @__PURE__ */ jsx2("span", { children: S.consent })
      ] }),
      /* @__PURE__ */ jsx2(BilledNote, { text: S.cloneBilled }),
      /* @__PURE__ */ jsxs2("div", { style: { alignItems: "center", display: "flex", gap: 10 }, children: [
        /* @__PURE__ */ jsx2(Button2, { disabled: !ready, loading: busy, onClick: () => void submit(), children: S.clone }),
        status && /* @__PURE__ */ jsx2("span", { role: "status", style: { ...muted, fontSize: 12 }, children: status })
      ] })
    ] })
  ] });
}
function DesignCard({ pin }) {
  const client = useQueryClient();
  const playing = useValue($playing);
  const [instruction, setInstruction] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [names, setNames] = useState({});
  const [saved, setSaved] = useState({});
  const [busy, setBusy] = useState(null);
  const inFlight = useRef(false);
  const design = async () => {
    if (inFlight.current) return;
    if (!samePin(currentPin(), pin)) return host2.notify({ kind: "error", message: S.agentChangedNothingSent });
    inFlight.current = true;
    setBusy("design");
    stop();
    try {
      const res = await post("/design", { instruction: instruction.trim(), n: 2 }, 18e4);
      if (!samePin(currentPin(), pin)) return;
      setCandidates(res.candidates);
      setNames({});
      setSaved({});
      void refreshAvailability();
    } catch (error) {
      if (samePin(currentPin(), pin)) host2.notify({ kind: "error", message: errorText(error) });
    } finally {
      inFlight.current = false;
      if (samePin(currentPin(), pin)) setBusy(null);
    }
  };
  const save = async (candidate) => {
    if (inFlight.current) return;
    if (!samePin(currentPin(), pin)) return host2.notify({ kind: "error", message: S.agentChangedNothingSent });
    const title = (names[candidate.design_token] ?? "").trim();
    inFlight.current = true;
    setBusy(candidate.design_token);
    try {
      const res = await post("/design/save", { design_token: candidate.design_token, title }, 12e4);
      if (!samePin(currentPin(), pin)) return;
      setSaved({ ...saved, [candidate.design_token]: res.voice.title });
      host2.notify({ kind: "success", message: S.saved(res.voice.title) });
      void client.invalidateQueries({ queryKey: ["fish-audio", agentKey(pin), "mine"] });
    } catch (error) {
      if (samePin(currentPin(), pin)) host2.notify({ kind: "error", message: errorText(error) });
    } finally {
      inFlight.current = false;
      if (samePin(currentPin(), pin)) setBusy(null);
    }
  };
  return /* @__PURE__ */ jsxs2("section", { style: card, children: [
    /* @__PURE__ */ jsx2("h2", { style: { fontSize: 15, fontWeight: 600, margin: "0 0 4px" }, children: S.designTitle }),
    /* @__PURE__ */ jsx2("p", { style: { ...muted, fontSize: 12, lineHeight: 1.5, margin: "0 0 12px" }, children: S.designBody }),
    /* @__PURE__ */ jsxs2("div", { style: { display: "grid", gap: 10 }, children: [
      /* @__PURE__ */ jsx2(
        Textarea,
        {
          "aria-label": S.designTitle,
          disabled: busy !== null,
          maxLength: 500,
          onChange: (e) => setInstruction(e.target.value),
          placeholder: S.designPlaceholder,
          rows: 3,
          value: instruction
        }
      ),
      /* @__PURE__ */ jsx2(BilledNote, { text: S.designBilled }),
      /* @__PURE__ */ jsx2("div", { children: /* @__PURE__ */ jsx2(Button2, { disabled: !instruction.trim() || busy !== null, loading: busy === "design", onClick: () => void design(), children: busy === "design" ? S.designing : S.design }) }),
      candidates.map((candidate, i) => {
        const key = `design:${candidate.design_token}`;
        return /* @__PURE__ */ jsxs2(
          "div",
          {
            style: { alignItems: "center", borderTop: "1px solid var(--ui-stroke-tertiary)", display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 10 },
            children: [
              /* @__PURE__ */ jsxs2(
                Button2,
                {
                  disabled: !candidate.audio,
                  onClick: () => samePin(currentPin(), pin) && (playing === key ? stop() : candidate.audio && play(key, candidate.audio, candidate.mime)),
                  size: "xs",
                  variant: "secondary",
                  children: [
                    /* @__PURE__ */ jsx2(Codicon2, { name: playing === key ? "debug-stop" : "play" }),
                    S.candidate(i + 1)
                  ]
                }
              ),
              saved[candidate.design_token] ? /* @__PURE__ */ jsx2("span", { style: { ...muted, fontSize: 12 }, children: S.saved(saved[candidate.design_token]) }) : /* @__PURE__ */ jsxs2(Fragment, { children: [
                /* @__PURE__ */ jsx2("div", { style: { flex: 1, minWidth: 140 }, children: /* @__PURE__ */ jsx2(
                  Input,
                  {
                    "aria-label": `${S.saveAs} ${i + 1}`,
                    onChange: (e) => setNames({ ...names, [candidate.design_token]: e.target.value }),
                    placeholder: S.saveAs,
                    value: names[candidate.design_token] ?? ""
                  }
                ) }),
                /* @__PURE__ */ jsx2(
                  Button2,
                  {
                    disabled: !(names[candidate.design_token] ?? "").trim() || busy !== null,
                    loading: busy === candidate.design_token,
                    onClick: () => void save(candidate),
                    size: "xs",
                    children: S.save
                  }
                )
              ] })
            ]
          },
          candidate.design_token
        );
      })
    ] })
  ] });
}

// src/desktop/page.tsx
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var pad = "0 24px";
function readFor(pin, path) {
  const changed = () => new ApiError("agent_changed", S.agentChangedNothingSent);
  if (!samePin(currentPin(), pin)) return Promise.reject(changed());
  return call(path).then((res) => {
    if (!samePin(currentPin(), pin)) throw changed();
    return res;
  });
}
var renews = (plan) => plan.cancel_at_period_end === false && ["active", "trialing"].includes(plan.subscription_status ?? "");
function VoicesPage() {
  const available = useValue2($available);
  const availableError = useValue2($availableError);
  const profile = useValue2(host3.state.profile);
  const connectionId = useValue2(host3.state.connectionId);
  const pin = { connectionId, profile };
  if (available === false) {
    return /* @__PURE__ */ jsx3(Frame, { profile, children: /* @__PURE__ */ jsx3("p", { style: { ...muted, fontSize: 13, lineHeight: 1.5, maxWidth: 560, padding: pad }, children: S.notSetUp(profile) }) });
  }
  if (available === null) {
    return /* @__PURE__ */ jsx3(Frame, { profile, children: availableError ? /* @__PURE__ */ jsx3("div", { style: { padding: pad }, children: /* @__PURE__ */ jsx3(ErrorState2, { description: errorText(availableError), title: S.unreachable(profile), children: /* @__PURE__ */ jsx3(Button3, { onClick: () => void refreshAvailability(), size: "xs", variant: "secondary", children: S.checkAgain }) }) }) : /* @__PURE__ */ jsx3(Rows, {}) });
  }
  if (!available.key) {
    return /* @__PURE__ */ jsx3(Frame, { profile, children: /* @__PURE__ */ jsx3(Onboarding, { profile }) });
  }
  return /* @__PURE__ */ jsx3(Body, { pin }, agentKey(pin));
}
function Frame({ children, profile, tabs }) {
  return /* @__PURE__ */ jsxs3("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }, children: [
    /* @__PURE__ */ jsxs3("header", { style: { alignItems: "center", display: "flex", gap: 10, padding: "20px 24px 12px" }, children: [
      /* @__PURE__ */ jsx3(Codicon3, { name: "unmute", size: 18 }),
      /* @__PURE__ */ jsx3("h1", { style: { fontSize: 18, fontWeight: 600, margin: 0 }, children: S.title }),
      /* @__PURE__ */ jsx3(Badge, { variant: "muted", children: S.poweredBy }),
      /* @__PURE__ */ jsx3("span", { style: { ...muted, fontSize: 12 }, children: S.forAgent(profile) }),
      /* @__PURE__ */ jsx3("div", { style: { flex: 1 } }),
      tabs
    ] }),
    /* @__PURE__ */ jsx3("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 24 }, children })
  ] });
}
function Onboarding({ profile }) {
  const open = (url) => void pluginCtx().os.openExternal(url);
  return /* @__PURE__ */ jsx3("div", { style: { padding: pad }, children: /* @__PURE__ */ jsxs3("div", { style: { ...card, maxWidth: 560 }, children: [
    /* @__PURE__ */ jsx3("h2", { style: { fontSize: 15, fontWeight: 600, margin: "0 0 6px" }, children: S.onboardTitle }),
    /* @__PURE__ */ jsx3("p", { style: { ...muted, fontSize: 13, lineHeight: 1.5, margin: "0 0 12px" }, children: S.onboardBody(profile) }),
    /* @__PURE__ */ jsxs3("ol", { style: { fontSize: 13, lineHeight: 1.8, listStyle: "decimal", margin: "0 0 14px", paddingLeft: 20 }, children: [
      /* @__PURE__ */ jsx3("li", { children: S.onboardStep1 }),
      /* @__PURE__ */ jsx3("li", { children: S.onboardStep2 })
    ] }),
    /* @__PURE__ */ jsxs3("div", { style: { display: "flex", gap: 8 }, children: [
      /* @__PURE__ */ jsx3(Button3, { onClick: () => open(LINKS.keys), children: S.getKey }),
      /* @__PURE__ */ jsx3(Button3, { onClick: () => host3.navigate("/capabilities?tab=plugins"), variant: "secondary", children: S.openPlugins }),
      /* @__PURE__ */ jsx3(Button3, { onClick: () => void refreshAvailability(), variant: "ghost", children: S.checkAgain })
    ] })
  ] }) });
}
function Body({ pin }) {
  const tab = useValue2($tab);
  const tabs = /* @__PURE__ */ jsx3(
    SegmentedControl,
    {
      onChange: (id) => $tab.set(id),
      options: ["library", "mine", "create", "account"].map((id) => ({ id, label: S.tabs[id] })),
      value: tab
    }
  );
  useEffect(() => () => releasePlayback(), []);
  return /* @__PURE__ */ jsxs3(Frame, { profile: pin.profile, tabs, children: [
    tab === "library" && /* @__PURE__ */ jsx3(Library, { pin }),
    tab === "mine" && /* @__PURE__ */ jsx3(MyVoices, { pin }),
    tab === "create" && /* @__PURE__ */ jsx3(CreateTab, { pin }),
    tab === "account" && /* @__PURE__ */ jsx3(AccountTab, { pin })
  ] });
}
function useDebounced(value, ms) {
  const [settled, setSettled] = useState2(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
var favouritesKey = (pin) => `favourites:${agentKey(pin)}`;
var $favouritesRevision = atom3(0);
function writeFavourites(pin, list) {
  pluginCtx().storage.set(favouritesKey(pin), list);
  $favouritesRevision.set($favouritesRevision.get() + 1);
}
function forgetFavourite(pin, id) {
  const list = pluginCtx().storage.get(favouritesKey(pin), []);
  if (list.some((f) => f.id === id)) writeFavourites(pin, list.filter((f) => f.id !== id));
}
function useFavourites(pin) {
  useValue2($favouritesRevision);
  const list = pluginCtx().storage.get(favouritesKey(pin), []);
  const toggle = (voice) => {
    const current = pluginCtx().storage.get(favouritesKey(pin), []);
    writeFavourites(
      pin,
      current.some((f) => f.id === voice.id) ? current.filter((f) => f.id !== voice.id) : [...current, { author: voice.author, id: voice.id, languages: voice.languages, title: voice.title }]
    );
  };
  return { has: (id) => list.some((f) => f.id === id), list, toggle };
}
function Library({ pin }) {
  const [text, setText] = useState2("");
  const [language, setLanguage] = useState2("any");
  const [page, setPage] = useState2(1);
  const [favouritesOnly, setFavouritesOnly] = useState2(false);
  const q = useDebounced(text.trim(), 350);
  const favourites = useFavourites(pin);
  useEffect(() => setPage(1), [q, language]);
  const voices = useQuery({
    enabled: !favouritesOnly,
    queryFn: () => readFor(pin, query("/voices", { language: language === "any" ? void 0 : language, page, q })),
    queryKey: ["fish-audio", agentKey(pin), "voices", q, language, page],
    retry: false,
    staleTime: 6e4
  });
  const list = favouritesOnly ? favourites.list : voices.data?.items;
  const more = !favouritesOnly && hasMore(voices.data?.items.length, page, voices.data?.total);
  return /* @__PURE__ */ jsxs3("div", { style: { display: "grid", gap: 12, padding: pad }, children: [
    /* @__PURE__ */ jsxs3("div", { style: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 10 }, children: [
      /* @__PURE__ */ jsx3("div", { style: { width: 280 }, children: /* @__PURE__ */ jsx3(SearchField, { "aria-label": S.search, onChange: setText, placeholder: S.search, value: text }) }),
      /* @__PURE__ */ jsx3("div", { style: { width: 160 }, children: /* @__PURE__ */ jsxs3(Select, { onValueChange: setLanguage, value: language, children: [
        /* @__PURE__ */ jsx3(SelectTrigger, { "aria-label": S.language, children: /* @__PURE__ */ jsx3(SelectValue, {}) }),
        /* @__PURE__ */ jsxs3(SelectContent, { children: [
          /* @__PURE__ */ jsx3(SelectItem, { value: "any", children: S.anyLanguage }),
          LANGUAGES.map(([code, label2]) => /* @__PURE__ */ jsx3(SelectItem, { value: code, children: label2 }, code))
        ] })
      ] }) }),
      /* @__PURE__ */ jsxs3(Button3, { "aria-pressed": favouritesOnly, onClick: () => setFavouritesOnly(!favouritesOnly), size: "xs", variant: favouritesOnly ? "secondary" : "ghost", children: [
        /* @__PURE__ */ jsx3(Codicon3, { name: favouritesOnly ? "star-full" : "star-empty" }),
        S.favouritesOnly
      ] })
    ] }),
    /* @__PURE__ */ jsx3(BilledNote, { text: S.billedNote }),
    !favouritesOnly && voices.error ? /* @__PURE__ */ jsx3(LoadError, { error: voices.error, onRetry: () => void voices.refetch() }) : !list ? /* @__PURE__ */ jsx3(Rows, {}) : list.length === 0 ? favouritesOnly ? /* @__PURE__ */ jsx3(EmptyState, { description: S.noFavouritesHint, title: S.noFavourites }) : /* @__PURE__ */ jsx3(EmptyState, { title: S.noVoices }) : /* @__PURE__ */ jsx3(VoiceList, { favourites, pin, voices: list }),
    !favouritesOnly && /* @__PURE__ */ jsx3(Pager, { more, page, setPage })
  ] });
}
var PAGE_SIZE = 20;
var LAST_PAGE = 50;
var hasMore = (items, page, total) => {
  if (typeof total === "number" && Number.isFinite(total) || typeof total === "string" && /^\d+$/.test(total)) {
    return page * PAGE_SIZE < Number(total) && page < LAST_PAGE;
  }
  return (items ?? 0) >= PAGE_SIZE && page < LAST_PAGE;
};
function Pager({ page, more, setPage }) {
  if (page <= 1 && !more) return null;
  return /* @__PURE__ */ jsxs3("div", { style: { alignItems: "center", display: "flex", gap: 8, justifyContent: "flex-end" }, children: [
    /* @__PURE__ */ jsx3(Button3, { disabled: page <= 1, onClick: () => setPage(page - 1), size: "xs", variant: "ghost", children: S.prev }),
    /* @__PURE__ */ jsx3("span", { style: { ...muted, fontSize: 12 }, children: S.pageOf(page) }),
    /* @__PURE__ */ jsx3(Button3, { disabled: !more, onClick: () => setPage(page + 1), size: "xs", variant: "ghost", children: S.next })
  ] });
}
var inFlightPreviews = /* @__PURE__ */ new Set();
var $usePending = atom3({});
async function previewVoice(pin, voiceId) {
  if (!samePin(currentPin(), pin)) return host3.notify({ kind: "error", message: S.agentChangedNothingSent });
  const key = `preview:${agentKey(pin)}:${voiceId}`;
  if ($playing.get() === key) return stop();
  const cached = cachedPreview(key);
  if (cached) return play(key, cached.audio, cached.mime);
  if (inFlightPreviews.has(key)) return;
  inFlightPreviews.add(key);
  const epoch2 = playbackEpoch();
  try {
    const res = await post("/preview", { voice: voiceId });
    if (!samePin(currentPin(), pin)) return;
    rememberPreview(key, res);
    if (playbackEpoch() === epoch2) play(key, res.audio, res.mime);
    void refreshAvailability();
  } finally {
    inFlightPreviews.delete(key);
  }
}
function VoiceList({ voices, pin, favourites, onDelete }) {
  const playing = useValue2($playing);
  const [busy, setBusy] = useState2(null);
  const [used, setUsed] = useState2(null);
  const pendingUse = useValue2($usePending)[agentKey(pin)];
  const run = async (id, action) => {
    if (!samePin(currentPin(), pin)) return host3.notify({ kind: "error", message: S.agentChangedNothingSent });
    setBusy(id);
    try {
      await action();
    } catch (error) {
      if (samePin(currentPin(), pin)) host3.notify({ kind: "error", message: errorText(error) });
    } finally {
      if (samePin(currentPin(), pin)) setBusy(null);
    }
  };
  const use = async (voice) => {
    const agent = agentKey(pin);
    if ($usePending.get()[agent]) return;
    $usePending.set({ ...$usePending.get(), [agent]: voice.id });
    try {
      await run(`use:${voice.id}`, async () => {
        const res = await post("/use", { voice: voice.id });
        if (!samePin(currentPin(), pin)) return;
        setUsed(voice.id);
        const note = res.message && res.message !== "Saved." ? ` ${res.message.replace(/^Saved\.\s*/, "")}` : "";
        host3.notify({ kind: "success", message: S.usedVoice(voice.title, pin.profile) + note });
      });
    } finally {
      const { [agent]: mine, ...rest } = $usePending.get();
      if (mine === voice.id) $usePending.set(rest);
    }
  };
  return /* @__PURE__ */ jsx3("div", { style: { border: "1px solid var(--ui-stroke-tertiary)", borderRadius: 6 }, children: voices.map((voice, i) => {
    const key = `preview:${agentKey(pin)}:${voice.id}`;
    const meta = [voice.author, (voice.languages ?? []).join(", "), voice.task_count ? S.uses(voice.task_count) : ""].filter(Boolean).join(" \xB7 ");
    return /* @__PURE__ */ jsxs3(
      "div",
      {
        style: {
          alignItems: "center",
          borderTop: i ? "1px solid var(--ui-stroke-tertiary)" : 0,
          display: "grid",
          gap: 12,
          gridTemplateColumns: "36px minmax(0, 1fr) auto",
          padding: "10px 12px"
        },
        children: [
          /* @__PURE__ */ jsx3(Avatar, { title: voice.title }),
          /* @__PURE__ */ jsxs3("div", { style: { minWidth: 0 }, children: [
            /* @__PURE__ */ jsx3("div", { style: { fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: voice.title }),
            /* @__PURE__ */ jsx3("div", { style: { ...muted, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: [meta, voice.description].filter(Boolean).join(" \u2014 ") })
          ] }),
          /* @__PURE__ */ jsxs3("div", { style: { alignItems: "center", display: "flex", gap: 6 }, children: [
            /* @__PURE__ */ jsxs3(
              Button3,
              {
                "aria-label": `${playing === key ? S.stop : S.preview} ${voice.title}`,
                loading: busy === `play:${voice.id}`,
                onClick: () => void run(`play:${voice.id}`, () => previewVoice(pin, voice.id)),
                size: "xs",
                title: S.billedNote,
                variant: "secondary",
                children: [
                  /* @__PURE__ */ jsx3(Codicon3, { name: playing === key ? "debug-stop" : "play" }),
                  playing === key ? S.stop : S.preview
                ]
              }
            ),
            /* @__PURE__ */ jsx3(
              Button3,
              {
                disabled: used === voice.id || pendingUse !== void 0 && pendingUse !== voice.id,
                loading: pendingUse === voice.id,
                onClick: () => void use(voice),
                size: "xs",
                variant: used === voice.id ? "ghost" : "default",
                children: used === voice.id ? S.inUse : S.use
              }
            ),
            favourites && /* @__PURE__ */ jsx3(
              Button3,
              {
                "aria-label": favourites.has(voice.id) ? S.unfavourite : S.favourite,
                onClick: () => favourites.toggle(voice),
                size: "icon-xs",
                style: { color: favourites.has(voice.id) ? "var(--ui-orange)" : void 0 },
                variant: "ghost",
                children: /* @__PURE__ */ jsx3(Codicon3, { name: favourites.has(voice.id) ? "star-full" : "star-empty" })
              }
            ),
            onDelete && /* @__PURE__ */ jsx3(Button3, { "aria-label": `${S.delete} ${voice.title}`, onClick: () => onDelete(voice), size: "icon-xs", variant: "ghost", children: /* @__PURE__ */ jsx3(Codicon3, { name: "trash" }) })
          ] })
        ]
      },
      voice.id
    );
  }) });
}
function Avatar({ title }) {
  const hue = [...title].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 360;
  return /* @__PURE__ */ jsx3(
    "div",
    {
      "aria-hidden": true,
      style: {
        alignItems: "center",
        background: `hsl(${hue} 55% 45% / 0.18)`,
        borderRadius: "50%",
        color: `hsl(${hue} 60% 55%)`,
        display: "flex",
        fontSize: 14,
        fontWeight: 600,
        height: 36,
        justifyContent: "center",
        width: 36
      },
      children: (title.trim()[0] ?? "?").toUpperCase()
    }
  );
}
function MyVoices({ pin }) {
  const client = useQueryClient2();
  const [page, setPage] = useState2(1);
  const queryKey = ["fish-audio", agentKey(pin), "mine"];
  const voices = useQuery({
    queryFn: () => readFor(pin, query("/voices", { page, self: "true" })),
    queryKey: [...queryKey, page],
    retry: false,
    staleTime: 3e4
  });
  const [target, setTarget] = useState2(null);
  return /* @__PURE__ */ jsxs3("div", { style: { display: "grid", gap: 12, padding: pad }, children: [
    /* @__PURE__ */ jsx3(BilledNote, { text: S.billedNote }),
    voices.error ? /* @__PURE__ */ jsx3(LoadError, { error: voices.error, onRetry: () => void voices.refetch() }) : !voices.data ? /* @__PURE__ */ jsx3(Rows, { n: 3 }) : voices.data.items.length === 0 ? /* @__PURE__ */ jsx3(EmptyState, { description: S.mineEmptyHint, title: S.mineEmpty }) : /* @__PURE__ */ jsx3(VoiceList, { onDelete: setTarget, pin, voices: voices.data.items }),
    /* @__PURE__ */ jsx3(Pager, { more: hasMore(voices.data?.items.length, page, voices.data?.total), page, setPage }),
    /* @__PURE__ */ jsx3(DeleteDialog, { pin, onClose: () => setTarget(null), onDeleted: () => void client.invalidateQueries({ queryKey }), voice: target })
  ] });
}
function DeleteDialog({ pin, voice, onClose, onDeleted }) {
  const [typed, setTyped] = useState2("");
  const [busy, setBusy] = useState2(false);
  useEffect(() => setTyped(""), [voice]);
  const confirm = async () => {
    if (!voice) return;
    if (!samePin(currentPin(), pin)) return host3.notify({ kind: "error", message: S.agentChangedNothingSent });
    setBusy(true);
    try {
      await call(`/voices/${encodeURIComponent(voice.id)}`, { method: "DELETE", timeoutMs: 6e4 });
      forgetFavourite(pin, voice.id);
      if (!samePin(currentPin(), pin)) return;
      host3.notify({ kind: "success", message: S.deleted(voice.title) });
      onDeleted();
      onClose();
    } catch (error) {
      if (samePin(currentPin(), pin)) host3.notify({ kind: "error", message: errorText(error) });
    } finally {
      if (samePin(currentPin(), pin)) setBusy(false);
    }
  };
  return /* @__PURE__ */ jsx3(Dialog, { onOpenChange: (open) => !open && onClose(), open: voice !== null, children: /* @__PURE__ */ jsxs3(DialogContent, { children: [
    /* @__PURE__ */ jsx3(DialogHeader, { children: /* @__PURE__ */ jsx3(DialogTitle, { children: voice ? S.deleteTitle(voice.title) : "" }) }),
    /* @__PURE__ */ jsx3("p", { style: { ...muted, fontSize: 13, lineHeight: 1.5, margin: 0 }, children: S.deleteBody }),
    /* @__PURE__ */ jsxs3("label", { style: { display: "grid", fontSize: 12, gap: 6 }, children: [
      voice ? S.deleteConfirmLabel(voice.title) : "",
      /* @__PURE__ */ jsx3(Input2, { "aria-label": voice ? S.deleteConfirmLabel(voice.title) : "", onChange: (e) => setTyped(e.target.value), value: typed })
    ] }),
    /* @__PURE__ */ jsxs3(DialogFooter, { children: [
      /* @__PURE__ */ jsx3(Button3, { onClick: onClose, variant: "ghost", children: S.cancel }),
      /* @__PURE__ */ jsx3(Button3, { disabled: !voice || typed !== voice.title, loading: busy, onClick: () => void confirm(), variant: "destructive", children: S.delete })
    ] })
  ] }) });
}
function AccountTab({ pin }) {
  const account = useQuery({
    queryFn: () => readFor(pin, "/account"),
    queryKey: ["fish-audio", agentKey(pin), "account"],
    retry: false,
    staleTime: 3e4
  });
  useEffect(() => {
    if (account.data && samePin(currentPin(), pin)) $account.set(account.data);
  }, [account.data]);
  const open = (url) => void pluginCtx().os.openExternal(url);
  if (account.error) return /* @__PURE__ */ jsx3("div", { style: { padding: pad }, children: /* @__PURE__ */ jsx3(LoadError, { error: account.error, onRetry: () => void account.refetch() }) });
  const data = account.data;
  if (!data) return /* @__PURE__ */ jsx3(Rows, { n: 2 });
  const plan = data.package;
  return /* @__PURE__ */ jsxs3("div", { style: { display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", maxWidth: 820, padding: pad }, children: [
    /* @__PURE__ */ jsxs3("div", { style: card, children: [
      /* @__PURE__ */ jsx3("div", { style: { ...muted, fontSize: 12 }, children: S.apiCredit }),
      /* @__PURE__ */ jsx3("div", { style: { color: data.low ? "var(--ui-orange)" : void 0, fontSize: 28, fontVariantNumeric: "tabular-nums", fontWeight: 600, margin: "4px 0 8px" }, children: S.usd(data.credit) }),
      data.low && /* @__PURE__ */ jsx3("p", { style: { color: "var(--ui-orange)", fontSize: 12, margin: "0 0 8px" }, children: S.lowCredit }),
      /* @__PURE__ */ jsxs3("div", { style: { ...muted, fontSize: 12, lineHeight: 1.7 }, children: [
        /* @__PURE__ */ jsxs3("div", { children: [
          S.topUps,
          ": ",
          S.usd(data.cumulative_top_up)
        ] }),
        data.has_free_credit && /* @__PURE__ */ jsx3("div", { children: S.freeCredit })
      ] }),
      /* @__PURE__ */ jsxs3("div", { style: { display: "flex", gap: 8, marginTop: 12 }, children: [
        /* @__PURE__ */ jsx3(Button3, { onClick: () => open(data.links.top_up), children: S.topUp }),
        /* @__PURE__ */ jsx3(Button3, { onClick: () => open(data.links.keys), variant: "ghost", children: S.apiKeys })
      ] })
    ] }),
    /* @__PURE__ */ jsxs3("div", { style: card, children: [
      /* @__PURE__ */ jsx3("div", { style: { ...muted, fontSize: 12 }, children: S.plan }),
      /* @__PURE__ */ jsx3("div", { style: { fontSize: 20, fontWeight: 600, margin: "4px 0 8px", textTransform: data.package_unavailable ? "none" : "capitalize" }, children: data.package_unavailable ? S.planUnavailable : plan?.type ?? S.noPlan }),
      plan && /* @__PURE__ */ jsxs3("div", { style: { ...muted, fontSize: 12, lineHeight: 1.7 }, children: [
        typeof plan.total === "number" && /* @__PURE__ */ jsx3("div", { children: S.planBalance(Number(plan.balance ?? 0), plan.total) }),
        plan.finished_at && /* @__PURE__ */ jsx3("div", { children: (renews(plan) ? S.renews : S.periodEnds)(String(plan.finished_at).slice(0, 10)) })
      ] }),
      /* @__PURE__ */ jsx3("p", { style: { ...muted, fontSize: 12, lineHeight: 1.5 }, children: S.creditsSeparate }),
      /* @__PURE__ */ jsx3(Button3, { onClick: () => open(data.links.plans), variant: "secondary", children: S.plans })
    ] })
  ] });
}

// src/desktop/plugin.tsx
import { jsx as jsx4 } from "react/jsx-runtime";
var PLUGIN_ID = "fish-audio";
var PAGE_PATH = "/fish-audio";
var PROBE_INTERVAL_MS = 6e4;
var ACCOUNT_REFRESH_MS = 5 * 6e4;
function openTab(tab) {
  $tab.set(tab);
  host4.navigate(PAGE_PATH);
}
function CreditChip() {
  const account = useValue3($account);
  if (!account) return null;
  return /* @__PURE__ */ jsx4(
    "button",
    {
      "aria-label": S.chipTip,
      onClick: () => openTab("account"),
      style: {
        alignItems: "center",
        background: "transparent",
        border: 0,
        color: account.low ? "var(--ui-orange)" : "var(--ui-text-tertiary)",
        cursor: "pointer",
        display: "inline-flex",
        fontSize: "0.6875rem",
        fontVariantNumeric: "tabular-nums",
        gap: 4,
        height: "100%",
        padding: "0 6px"
      },
      title: account.low ? S.lowCredit : S.chipTip,
      type: "button",
      children: S.chip(S.usd(account.credit))
    }
  );
}
function registerAvailabilityGate(ctx) {
  let removers = null;
  let disposed = false;
  let generation = 0;
  let accountAt = 0;
  let forcePending = false;
  $available.set(null);
  $account.set(null);
  $availableError.set(null);
  const show = (available) => {
    if (disposed) return;
    if (available && !removers) {
      removers = [
        ctx.register({
          id: "nav",
          area: SIDEBAR_NAV_AREA,
          order: 46,
          data: { codicon: "unmute", label: S.navLabel, path: PAGE_PATH }
        }),
        ctx.register({ id: "credit", area: STATUSBAR_AREAS.right, order: 70, render: () => /* @__PURE__ */ jsx4(CreditChip, {}) }),
        ctx.register({
          id: "palette-voices",
          area: PALETTE_AREA,
          data: { id: "fish-audio.voices", keywords: ["fish", "voice", "tts"], label: S.paletteVoices, run: () => openTab("library") }
        }),
        ctx.register({
          id: "palette-account",
          area: PALETTE_AREA,
          data: { id: "fish-audio.account", keywords: ["fish", "credit", "balance"], label: S.paletteAccount, run: () => openTab("account") }
        })
      ];
    } else if (!available && removers) {
      removers.forEach((remove) => remove());
      removers = null;
    }
  };
  const probe = (force = false) => {
    if (force) {
      forcePending = true;
      $availableError.set(null);
    }
    const mine = ++generation;
    return ctx.rest("/available").then(
      (res) => {
        if (mine !== generation || disposed) return;
        $availableError.set(null);
        $available.set({ key: res?.key === true, version: String(res?.version ?? "") });
        show(true);
        if (res?.key !== true) {
          $account.set(null);
          return;
        }
        if (!forcePending && $account.get() !== null && Date.now() - accountAt < ACCOUNT_REFRESH_MS) return;
        accountAt = Date.now();
        return ctx.rest("/account").then(
          (account) => {
            if (mine === generation && !disposed) {
              forcePending = false;
              $account.set(account?.ok ? account : null);
            }
          },
          () => void 0
        );
      },
      (error) => {
        if (mine !== generation || disposed) return;
        if (!isNotFoundError(error)) {
          if ($available.get() === null) $availableError.set(error);
          return;
        }
        $availableError.set(null);
        $available.set(false);
        $account.set(null);
        show(false);
      }
    );
  };
  void probe(true);
  ctx.setInterval(() => void probe(), PROBE_INTERVAL_MS);
  const onAgentChange = () => {
    if (disposed) return;
    endAgentOperations();
    $account.set(null);
    $available.set(null);
    show(false);
    void probe(true);
  };
  const stops = [host4.state.profile.listen(onAgentChange), host4.state.connectionId.listen(onAgentChange)];
  ctx.onDispose(() => {
    disposed = true;
    stops.forEach((stop2) => stop2());
  });
  return { probe };
}
var plugin = {
  id: PLUGIN_ID,
  name: "Fish Audio",
  description: "A Voices page for Fish Audio: search and preview the voice library, use a voice, clone or design voices, and see your account.",
  register(ctx) {
    bindContext(ctx);
    ctx.register({
      id: "page",
      area: ROUTES_AREA,
      data: { path: PAGE_PATH },
      render: () => /* @__PURE__ */ jsx4(VoicesPage, {})
    });
    setRefresher(registerAvailabilityGate(ctx).probe);
    ctx.onDispose(releasePlayback);
    ctx.onDispose(endAgentOperations);
  }
};
var plugin_default = plugin;
export {
  PAGE_PATH,
  PLUGIN_ID,
  plugin_default as default,
  isNotFoundError,
  openTab,
  registerAvailabilityGate
};
