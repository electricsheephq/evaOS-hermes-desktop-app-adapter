// Generated from src/desktop by scripts/build-desktop.mjs. Do not edit by hand.

// src/desktop/plugin.tsx
import {
  host as host4,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  usePluginI18n as usePluginI18n5,
  useValue as useValue4
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
  atom as atom4,
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
  usePluginI18n as usePluginI18n4,
  useValue as useValue3
} from "@hermes/plugin-sdk";
import { useEffect, useState as useState2 } from "react";

// src/desktop/create.tsx
import { Button as Button2, Checkbox, Codicon as Codicon2, host as host2, Input, Textarea, useQueryClient, usePluginI18n as usePluginI18n3, useValue as useValue2 } from "@hermes/plugin-sdk";
import { useRef, useState } from "react";

// src/desktop/favourites.ts
import { atom as atom3 } from "@hermes/plugin-sdk";
var favouritesKey = (pin) => `favourites:${agentKey(pin)}`;
var $favouritesRevision = atom3(0);
function readFavourites(pin) {
  return pluginCtx().storage.get(favouritesKey(pin), []);
}
function writeFavourites(pin, list) {
  pluginCtx().storage.set(favouritesKey(pin), list);
  $favouritesRevision.set($favouritesRevision.get() + 1);
}
function forgetFavourite(pin, id) {
  const list = readFavourites(pin);
  if (list.some((f) => f.id === id)) writeFavourites(pin, list.filter((f) => f.id !== id));
}
function keepCreated(pin, voice) {
  const available = $available.get();
  if (!available || available.account !== false) return false;
  const list = readFavourites(pin);
  if (!list.some((f) => f.id === voice.id)) writeFavourites(pin, [...list, { id: voice.id, title: voice.title }]);
  return true;
}

// src/desktop/strings.ts
import { usePluginI18n, useValue } from "@hermes/plugin-sdk";
var PLUGIN_ID = "fish-audio";
var PAGE_PATH = "/fish-audio";
function useAccountText(normal, operator) {
  const t = usePluginI18n(PLUGIN_ID);
  const available = useValue($available);
  return t(available && available.account === false ? operator : normal);
}
var LINKS = {
  keys: "https://fish.audio/app/api-keys",
  discovery: "https://fish.audio/discovery"
};
var LANGUAGES = ["en", "zh", "ja", "ko", "es", "fr", "de", "it", "pt", "ru", "ar", "nl", "pl"];

// src/desktop/ui.tsx
import { Button, Codicon, ErrorState, Skeleton, usePluginI18n as usePluginI18n2 } from "@hermes/plugin-sdk";
import { jsx, jsxs } from "react/jsx-runtime";
var muted = { color: "var(--ui-text-tertiary)" };
var card = {
  background: "var(--ui-bg-card)",
  border: "1px solid var(--ui-stroke-tertiary)",
  borderRadius: 6,
  padding: 16
};
function Rows({ n = 4 }) {
  const t = usePluginI18n2(PLUGIN_ID);
  return /* @__PURE__ */ jsx("div", { "aria-busy": "true", style: { display: "grid", gap: 10, padding: "0 24px" }, children: Array.from({ length: n }, (_, i) => /* @__PURE__ */ jsx(Skeleton, { style: { height: 44 } }, i)) });
}
function BilledNote({ text }) {
  const t = usePluginI18n2(PLUGIN_ID);
  return /* @__PURE__ */ jsxs("p", { style: { ...muted, alignItems: "center", display: "flex", fontSize: 12, gap: 6, margin: 0 }, children: [
    /* @__PURE__ */ jsx(Codicon, { name: "info" }),
    text
  ] });
}
function LoadError({ error, onRetry }) {
  const t = usePluginI18n2(PLUGIN_ID);
  return /* @__PURE__ */ jsx(ErrorState, { description: errorText(error), title: t("loadFailed"), children: /* @__PURE__ */ jsx(Button, { onClick: onRetry, size: "xs", variant: "secondary", children: t("retry") }) });
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
  const t = usePluginI18n3(PLUGIN_ID);
  return /* @__PURE__ */ jsxs2("div", { style: { display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", padding: "0 24px" }, children: [
    /* @__PURE__ */ jsx2(DesignCard, { pin }),
    /* @__PURE__ */ jsx2(CloneCard, { pin })
  ] });
}
function CloneCard({ pin }) {
  const t = usePluginI18n3(PLUGIN_ID);
  const billedNote = useAccountText("cloneBilled", "operatorCloneBilled");
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
    if (chosen.length > MAX_FILES) return setStatus({ key: "tooMany", args: [] });
    if (tooBig) return setStatus({ key: "tooLarge", args: [tooBig.name] });
    setStatus(null);
    setFiles(chosen);
  };
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    if (!samePin(currentPin(), pin)) return setStatus({ key: "agentChangedNothingSent", args: [] });
    inFlight.current = true;
    setBusy(true);
    try {
      const voice = await cloneVoice(
        files,
        { consent, description: description.trim(), title: title.trim() },
        pin,
        { current: currentPin, epoch: currentAgentEpoch, rest: (path, opts) => pluginCtx().rest(path, opts) },
        (n, sent, total) => setStatus({ key: "uploading", args: [n, files.length, Math.round(sent / Math.max(1, total) * 100)] })
      );
      if (!samePin(currentPin(), pin)) return;
      setStatus({ key: keepCreated(pin, voice) ? "operatorCloned" : "cloned", args: [voice.title] });
      setFiles([]);
      setTitle("");
      setDescription("");
      setConsent(false);
      void client.invalidateQueries({ queryKey: ["fish-audio", agentKey(pin), "mine"] });
      void refreshAvailability();
    } catch (error) {
      if (!samePin(currentPin(), pin)) return;
      setStatus(error instanceof AgentChanged ? { key: "agentChanged", args: [] } : errorText(error));
    } finally {
      inFlight.current = false;
      if (samePin(currentPin(), pin)) setBusy(false);
    }
  };
  const ready = files.length > 0 && title.trim().length > 0 && consent && !busy;
  return /* @__PURE__ */ jsxs2("section", { style: card, children: [
    /* @__PURE__ */ jsx2("h2", { style: { fontSize: 15, fontWeight: 600, margin: "0 0 4px" }, children: t("cloneTitle") }),
    /* @__PURE__ */ jsx2("p", { style: { ...muted, fontSize: 12, lineHeight: 1.5, margin: "0 0 12px" }, children: t("cloneBody") }),
    /* @__PURE__ */ jsxs2("div", { style: { display: "grid", gap: 10 }, children: [
      /* @__PURE__ */ jsx2("input", { accept: "audio/*,.mp3,.wav,.ogg,.webm,.flac,.m4a,.mp4", hidden: true, multiple: true, onChange: pick, ref: input, type: "file" }),
      /* @__PURE__ */ jsxs2("div", { style: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }, children: [
        /* @__PURE__ */ jsxs2(Button2, { disabled: busy, onClick: () => input.current?.click(), size: "xs", variant: "secondary", children: [
          /* @__PURE__ */ jsx2(Codicon2, { name: "cloud-upload" }),
          t("chooseFiles")
        ] }),
        /* @__PURE__ */ jsx2("span", { style: { ...muted, fontSize: 12 }, children: files.map((file) => file.name).join(", ") })
      ] }),
      /* @__PURE__ */ jsxs2("label", { style: label, children: [
        t("voiceTitle"),
        /* @__PURE__ */ jsx2(Input, { disabled: busy, onChange: (e) => setTitle(e.target.value), value: title })
      ] }),
      /* @__PURE__ */ jsxs2("label", { style: label, children: [
        t("descriptionOptional"),
        /* @__PURE__ */ jsx2(Input, { disabled: busy, onChange: (e) => setDescription(e.target.value), value: description })
      ] }),
      /* @__PURE__ */ jsxs2("label", { style: { alignItems: "flex-start", display: "flex", fontSize: 12, gap: 8, lineHeight: 1.4 }, children: [
        /* @__PURE__ */ jsx2(
          Checkbox,
          {
            "aria-label": t("consent"),
            checked: consent,
            disabled: busy,
            onCheckedChange: (value) => setConsent(value === true),
            style: consent ? void 0 : { borderColor: "var(--ui-text-tertiary)" }
          }
        ),
        /* @__PURE__ */ jsx2("span", { children: t("consent") })
      ] }),
      /* @__PURE__ */ jsx2(BilledNote, { text: billedNote }),
      /* @__PURE__ */ jsxs2("div", { style: { alignItems: "center", display: "flex", gap: 10 }, children: [
        /* @__PURE__ */ jsx2(Button2, { disabled: !ready, loading: busy, onClick: () => void submit(), children: t("clone") }),
        status && /* @__PURE__ */ jsx2("span", { role: "status", style: { ...muted, fontSize: 12 }, children: typeof status === "string" ? status : t(status.key, ...status.args) })
      ] })
    ] })
  ] });
}
function DesignCard({ pin }) {
  const t = usePluginI18n3(PLUGIN_ID);
  const billedNote = useAccountText("designBilled", "operatorDesignBilled");
  const available = useValue2($available);
  const savedKey = available && available.account === false ? "operatorSaved" : "saved";
  const client = useQueryClient();
  const playing = useValue2($playing);
  const [instruction, setInstruction] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [names, setNames] = useState({});
  const [saved, setSaved] = useState({});
  const [busy, setBusy] = useState(null);
  const inFlight = useRef(false);
  const design = async () => {
    if (inFlight.current) return;
    if (!samePin(currentPin(), pin)) return host2.notify({ kind: "error", message: pluginCtx().i18n.t("agentChangedNothingSent") });
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
    if (!samePin(currentPin(), pin)) return host2.notify({ kind: "error", message: pluginCtx().i18n.t("agentChangedNothingSent") });
    const title = (names[candidate.design_token] ?? "").trim();
    inFlight.current = true;
    setBusy(candidate.design_token);
    try {
      const res = await post("/design/save", { design_token: candidate.design_token, title }, 12e4);
      if (!samePin(currentPin(), pin)) return;
      setSaved({ ...saved, [candidate.design_token]: res.voice.title });
      host2.notify({ kind: "success", message: keepCreated(pin, res.voice) ? pluginCtx().i18n.t("operatorSaved", res.voice.title) : pluginCtx().i18n.t("saved", res.voice.title) });
      void client.invalidateQueries({ queryKey: ["fish-audio", agentKey(pin), "mine"] });
    } catch (error) {
      if (samePin(currentPin(), pin)) host2.notify({ kind: "error", message: errorText(error) });
    } finally {
      inFlight.current = false;
      if (samePin(currentPin(), pin)) setBusy(null);
    }
  };
  return /* @__PURE__ */ jsxs2("section", { style: card, children: [
    /* @__PURE__ */ jsx2("h2", { style: { fontSize: 15, fontWeight: 600, margin: "0 0 4px" }, children: t("designTitle") }),
    /* @__PURE__ */ jsx2("p", { style: { ...muted, fontSize: 12, lineHeight: 1.5, margin: "0 0 12px" }, children: t("designBody") }),
    /* @__PURE__ */ jsxs2("div", { style: { display: "grid", gap: 10 }, children: [
      /* @__PURE__ */ jsx2(
        Textarea,
        {
          "aria-label": t("designTitle"),
          disabled: busy !== null,
          maxLength: 500,
          onChange: (e) => setInstruction(e.target.value),
          placeholder: t("designPlaceholder"),
          rows: 3,
          value: instruction
        }
      ),
      /* @__PURE__ */ jsx2(BilledNote, { text: billedNote }),
      /* @__PURE__ */ jsx2("div", { children: /* @__PURE__ */ jsx2(Button2, { disabled: !instruction.trim() || busy !== null, loading: busy === "design", onClick: () => void design(), children: busy === "design" ? t("designing") : t("design") }) }),
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
                    t("candidate", i + 1)
                  ]
                }
              ),
              saved[candidate.design_token] ? /* @__PURE__ */ jsx2("span", { style: { ...muted, fontSize: 12 }, children: t(savedKey, saved[candidate.design_token]) }) : /* @__PURE__ */ jsxs2(Fragment, { children: [
                /* @__PURE__ */ jsx2("div", { style: { flex: 1, minWidth: 140 }, children: /* @__PURE__ */ jsx2(
                  Input,
                  {
                    "aria-label": `${t("saveAs")} ${i + 1}`,
                    onChange: (e) => setNames({ ...names, [candidate.design_token]: e.target.value }),
                    placeholder: t("saveAs"),
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
                    children: t("save")
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
import { Fragment as Fragment2, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var pad = "0 24px";
function readFor(pin, path) {
  const changed = () => new ApiError("agent_changed", pluginCtx().i18n.t("agentChangedNothingSent"));
  if (!samePin(currentPin(), pin)) return Promise.reject(changed());
  return call(path).then((res) => {
    if (!samePin(currentPin(), pin)) throw changed();
    return res;
  });
}
var renews = (plan) => plan.cancel_at_period_end === false && ["active", "trialing"].includes(plan.subscription_status ?? "");
function VoicesPage() {
  const t = usePluginI18n4(PLUGIN_ID);
  const available = useValue3($available);
  const availableError = useValue3($availableError);
  const profile = useValue3(host3.state.profile);
  const connectionId = useValue3(host3.state.connectionId);
  const pin = { connectionId, profile };
  if (available === false) {
    return /* @__PURE__ */ jsx3(Frame, { profile, children: /* @__PURE__ */ jsx3("p", { style: { ...muted, fontSize: 13, lineHeight: 1.5, maxWidth: 560, padding: pad }, children: t("notSetUp", profile) }) });
  }
  if (available === null) {
    return /* @__PURE__ */ jsx3(Frame, { profile, children: availableError ? /* @__PURE__ */ jsx3("div", { style: { padding: pad }, children: /* @__PURE__ */ jsx3(ErrorState2, { description: errorText(availableError), title: t("unreachable", profile), children: /* @__PURE__ */ jsx3(Button3, { onClick: () => void refreshAvailability(), size: "xs", variant: "secondary", children: t("checkAgain") }) }) }) : /* @__PURE__ */ jsx3(Rows, {}) });
  }
  if (!available.key) {
    return /* @__PURE__ */ jsx3(Frame, { profile, children: /* @__PURE__ */ jsx3(Onboarding, { profile, operator: available.account === false }) });
  }
  return /* @__PURE__ */ jsx3(Body, { pin }, agentKey(pin));
}
function Frame({ children, profile, tabs }) {
  const t = usePluginI18n4(PLUGIN_ID);
  return /* @__PURE__ */ jsxs3("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }, children: [
    /* @__PURE__ */ jsxs3("header", { style: { alignItems: "center", display: "flex", gap: 10, padding: "20px 24px 12px" }, children: [
      /* @__PURE__ */ jsx3(Codicon3, { name: "unmute", size: 18 }),
      /* @__PURE__ */ jsx3("h1", { style: { fontSize: 18, fontWeight: 600, margin: 0 }, children: t("title") }),
      /* @__PURE__ */ jsx3(Badge, { variant: "muted", children: t("poweredBy") }),
      /* @__PURE__ */ jsx3("span", { style: { ...muted, fontSize: 12 }, children: t("forAgent", profile) }),
      /* @__PURE__ */ jsx3("div", { style: { flex: 1 } }),
      tabs
    ] }),
    /* @__PURE__ */ jsx3("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 24 }, children })
  ] });
}
function Onboarding({ profile, operator }) {
  const t = usePluginI18n4(PLUGIN_ID);
  const open = (url) => void pluginCtx().os.openExternal(url);
  return /* @__PURE__ */ jsx3("div", { style: { padding: pad }, children: /* @__PURE__ */ jsxs3("div", { style: { ...card, maxWidth: 560 }, children: [
    /* @__PURE__ */ jsx3("h2", { style: { fontSize: 15, fontWeight: 600, margin: "0 0 6px" }, children: operator ? t("operatorOnboardTitle") : t("onboardTitle") }),
    /* @__PURE__ */ jsx3("p", { style: { ...muted, fontSize: 13, lineHeight: 1.5, margin: "0 0 12px" }, children: operator ? t("operatorOnboardBody") : t("onboardBody", profile) }),
    !operator && /* @__PURE__ */ jsxs3("ol", { style: { fontSize: 13, lineHeight: 1.8, listStyle: "decimal", margin: "0 0 14px", paddingLeft: 20 }, children: [
      /* @__PURE__ */ jsx3("li", { children: t("onboardStep1") }),
      /* @__PURE__ */ jsx3("li", { children: t("onboardStep2") })
    ] }),
    /* @__PURE__ */ jsxs3("div", { style: { display: "flex", gap: 8 }, children: [
      !operator && /* @__PURE__ */ jsxs3(Fragment2, { children: [
        /* @__PURE__ */ jsx3(Button3, { onClick: () => open(LINKS.keys), children: t("getKey") }),
        /* @__PURE__ */ jsx3(Button3, { onClick: () => host3.navigate("/settings?tab=plugins&agent=fish-audio"), variant: "secondary", children: t("openPlugins") })
      ] }),
      /* @__PURE__ */ jsx3(Button3, { onClick: () => void refreshAvailability(), variant: "ghost", children: t("checkAgain") })
    ] })
  ] }) });
}
function Body({ pin }) {
  const t = usePluginI18n4(PLUGIN_ID);
  const selected = useValue3($tab);
  const available = useValue3($available);
  const operator = available && available.account === false;
  const hidden = operator && (selected === "account" || selected === "mine");
  const tab = hidden ? "library" : selected;
  useEffect(() => {
    if (hidden) $tab.set("library");
  }, [hidden]);
  const tabs = /* @__PURE__ */ jsx3(
    SegmentedControl,
    {
      onChange: (id) => $tab.set(id),
      options: ["library", "mine", "create", "account"].filter((id) => !operator || id !== "account" && id !== "mine").map((id) => ({ id, label: t(`tabs.${id}`) })),
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
function useFavourites(pin) {
  useValue3($favouritesRevision);
  const list = readFavourites(pin);
  const toggle = (voice) => {
    const current = readFavourites(pin);
    writeFavourites(
      pin,
      current.some((f) => f.id === voice.id) ? current.filter((f) => f.id !== voice.id) : [...current, { author: voice.author, id: voice.id, languages: voice.languages, title: voice.title }]
    );
  };
  return { has: (id) => list.some((f) => f.id === id), list, toggle };
}
function Library({ pin }) {
  const t = usePluginI18n4(PLUGIN_ID);
  const billedNote = useAccountText("billedNote", "operatorBilledNote");
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
      /* @__PURE__ */ jsx3("div", { style: { width: 280 }, children: /* @__PURE__ */ jsx3(SearchField, { "aria-label": t("search"), onChange: setText, placeholder: t("search"), value: text }) }),
      /* @__PURE__ */ jsx3("div", { style: { width: 160 }, children: /* @__PURE__ */ jsxs3(Select, { onValueChange: setLanguage, value: language, children: [
        /* @__PURE__ */ jsx3(SelectTrigger, { "aria-label": t("language"), children: /* @__PURE__ */ jsx3(SelectValue, {}) }),
        /* @__PURE__ */ jsxs3(SelectContent, { children: [
          /* @__PURE__ */ jsx3(SelectItem, { value: "any", children: t("anyLanguage") }),
          LANGUAGES.map((code) => /* @__PURE__ */ jsx3(SelectItem, { value: code, children: t(`languages.${code}`) }, code))
        ] })
      ] }) }),
      /* @__PURE__ */ jsxs3(Button3, { "aria-pressed": favouritesOnly, onClick: () => setFavouritesOnly(!favouritesOnly), size: "xs", variant: favouritesOnly ? "secondary" : "ghost", children: [
        /* @__PURE__ */ jsx3(Codicon3, { name: favouritesOnly ? "star-full" : "star-empty" }),
        t("favouritesOnly")
      ] })
    ] }),
    /* @__PURE__ */ jsx3(BilledNote, { text: billedNote }),
    !favouritesOnly && voices.error ? /* @__PURE__ */ jsx3(LoadError, { error: voices.error, onRetry: () => void voices.refetch() }) : !list ? /* @__PURE__ */ jsx3(Rows, {}) : list.length === 0 ? favouritesOnly ? /* @__PURE__ */ jsx3(EmptyState, { description: t("noFavouritesHint"), title: t("noFavourites") }) : /* @__PURE__ */ jsx3(EmptyState, { title: t("noVoices") }) : /* @__PURE__ */ jsx3(VoiceList, { favourites, pin, voices: list }),
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
  const t = usePluginI18n4(PLUGIN_ID);
  if (page <= 1 && !more) return null;
  return /* @__PURE__ */ jsxs3("div", { style: { alignItems: "center", display: "flex", gap: 8, justifyContent: "flex-end" }, children: [
    /* @__PURE__ */ jsx3(Button3, { disabled: page <= 1, onClick: () => setPage(page - 1), size: "xs", variant: "ghost", children: t("prev") }),
    /* @__PURE__ */ jsx3("span", { style: { ...muted, fontSize: 12 }, children: t("pageOf", page) }),
    /* @__PURE__ */ jsx3(Button3, { disabled: !more, onClick: () => setPage(page + 1), size: "xs", variant: "ghost", children: t("next") })
  ] });
}
var inFlightPreviews = /* @__PURE__ */ new Set();
var $usePending = atom4({});
async function previewVoice(pin, voiceId) {
  if (!samePin(currentPin(), pin)) return host3.notify({ kind: "error", message: pluginCtx().i18n.t("agentChangedNothingSent") });
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
  const t = usePluginI18n4(PLUGIN_ID);
  const billedNote = useAccountText("billedNote", "operatorBilledNote");
  const playing = useValue3($playing);
  const [busy, setBusy] = useState2(null);
  const [used, setUsed] = useState2(null);
  const pendingUse = useValue3($usePending)[agentKey(pin)];
  const run = async (id, action) => {
    if (!samePin(currentPin(), pin)) return host3.notify({ kind: "error", message: pluginCtx().i18n.t("agentChangedNothingSent") });
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
        const i18n = pluginCtx().i18n;
        const note = res.provider ? ` ${i18n.t(res.operator_pinned ? "useProviderByOperator" : "useOtherProvider", res.provider)}` : res.provider === void 0 && res.message && res.message !== "Saved." ? ` ${res.message.replace(/^Saved\.\s*/, "")}` : "";
        host3.notify({ kind: "success", message: i18n.t("usedVoice", voice.title, pin.profile) + note });
      });
    } finally {
      const { [agent]: mine, ...rest } = $usePending.get();
      if (mine === voice.id) $usePending.set(rest);
    }
  };
  return /* @__PURE__ */ jsx3("div", { style: { border: "1px solid var(--ui-stroke-tertiary)", borderRadius: 6 }, children: voices.map((voice, i) => {
    const key = `preview:${agentKey(pin)}:${voice.id}`;
    const parts = [voice.author, (voice.languages ?? []).join(", "), voice.task_count ? t("uses", voice.task_count) : "", voice.description].filter(Boolean).map((part, j, all) => /* @__PURE__ */ jsxs3("span", { children: [
      j ? j === all.length - 1 && voice.description ? " \u2014 " : " \xB7 " : "",
      /* @__PURE__ */ jsx3("bdi", { children: part })
    ] }, j));
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
            /* @__PURE__ */ jsx3("div", { style: { ...muted, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: parts })
          ] }),
          /* @__PURE__ */ jsxs3("div", { style: { alignItems: "center", display: "flex", gap: 6 }, children: [
            /* @__PURE__ */ jsxs3(
              Button3,
              {
                "aria-label": `${playing === key ? t("stop") : t("preview")} ${voice.title}`,
                loading: busy === `play:${voice.id}`,
                onClick: () => void run(`play:${voice.id}`, () => previewVoice(pin, voice.id)),
                size: "xs",
                title: billedNote,
                variant: "secondary",
                children: [
                  /* @__PURE__ */ jsx3(Codicon3, { name: playing === key ? "debug-stop" : "play" }),
                  playing === key ? t("stop") : t("preview")
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
                children: used === voice.id ? t("inUse") : t("use")
              }
            ),
            favourites && /* @__PURE__ */ jsx3(
              Button3,
              {
                "aria-label": favourites.has(voice.id) ? t("unfavourite") : t("favourite"),
                onClick: () => favourites.toggle(voice),
                size: "icon-xs",
                style: { color: favourites.has(voice.id) ? "var(--ui-orange)" : void 0 },
                variant: "ghost",
                children: /* @__PURE__ */ jsx3(Codicon3, { name: favourites.has(voice.id) ? "star-full" : "star-empty" })
              }
            ),
            onDelete && /* @__PURE__ */ jsx3(Button3, { "aria-label": `${t("delete")} ${voice.title}`, onClick: () => onDelete(voice), size: "icon-xs", variant: "ghost", children: /* @__PURE__ */ jsx3(Codicon3, { name: "trash" }) })
          ] })
        ]
      },
      voice.id
    );
  }) });
}
function Avatar({ title }) {
  const t = usePluginI18n4(PLUGIN_ID);
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
  const t = usePluginI18n4(PLUGIN_ID);
  const billedNote = useAccountText("billedNote", "operatorBilledNote");
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
    /* @__PURE__ */ jsx3(BilledNote, { text: billedNote }),
    voices.error ? /* @__PURE__ */ jsx3(LoadError, { error: voices.error, onRetry: () => void voices.refetch() }) : !voices.data ? /* @__PURE__ */ jsx3(Rows, { n: 3 }) : voices.data.items.length === 0 ? /* @__PURE__ */ jsx3(EmptyState, { description: t("mineEmptyHint"), title: t("mineEmpty") }) : /* @__PURE__ */ jsx3(VoiceList, { onDelete: setTarget, pin, voices: voices.data.items }),
    /* @__PURE__ */ jsx3(Pager, { more: hasMore(voices.data?.items.length, page, voices.data?.total), page, setPage }),
    /* @__PURE__ */ jsx3(DeleteDialog, { pin, onClose: () => setTarget(null), onDeleted: () => void client.invalidateQueries({ queryKey }), voice: target })
  ] });
}
function DeleteDialog({ pin, voice, onClose, onDeleted }) {
  const t = usePluginI18n4(PLUGIN_ID);
  const [typed, setTyped] = useState2("");
  const [busy, setBusy] = useState2(false);
  useEffect(() => setTyped(""), [voice]);
  const confirm = async () => {
    if (!voice) return;
    if (!samePin(currentPin(), pin)) return host3.notify({ kind: "error", message: pluginCtx().i18n.t("agentChangedNothingSent") });
    setBusy(true);
    try {
      await call(`/voices/${encodeURIComponent(voice.id)}`, { method: "DELETE", timeoutMs: 6e4 });
      forgetFavourite(pin, voice.id);
      if (!samePin(currentPin(), pin)) return;
      host3.notify({ kind: "success", message: pluginCtx().i18n.t("deleted", voice.title) });
      onDeleted();
      onClose();
    } catch (error) {
      if (samePin(currentPin(), pin)) host3.notify({ kind: "error", message: errorText(error) });
    } finally {
      if (samePin(currentPin(), pin)) setBusy(false);
    }
  };
  return /* @__PURE__ */ jsx3(Dialog, { onOpenChange: (open) => !open && onClose(), open: voice !== null, children: /* @__PURE__ */ jsxs3(DialogContent, { children: [
    /* @__PURE__ */ jsx3(DialogHeader, { children: /* @__PURE__ */ jsx3(DialogTitle, { children: voice ? t("deleteTitle", voice.title) : "" }) }),
    /* @__PURE__ */ jsx3("p", { style: { ...muted, fontSize: 13, lineHeight: 1.5, margin: 0 }, children: t("deleteBody") }),
    /* @__PURE__ */ jsxs3("label", { style: { display: "grid", fontSize: 12, gap: 6 }, children: [
      voice ? t("deleteConfirmLabel", voice.title) : "",
      /* @__PURE__ */ jsx3(Input2, { "aria-label": voice ? t("deleteConfirmLabel", voice.title) : "", onChange: (e) => setTyped(e.target.value), value: typed })
    ] }),
    /* @__PURE__ */ jsxs3(DialogFooter, { children: [
      /* @__PURE__ */ jsx3(Button3, { onClick: onClose, variant: "ghost", children: t("cancel") }),
      /* @__PURE__ */ jsx3(Button3, { disabled: !voice || typed !== voice.title, loading: busy, onClick: () => void confirm(), variant: "destructive", children: t("delete") })
    ] })
  ] }) });
}
function AccountTab({ pin }) {
  const t = usePluginI18n4(PLUGIN_ID);
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
      /* @__PURE__ */ jsx3("div", { style: { ...muted, fontSize: 12 }, children: t("apiCredit") }),
      /* @__PURE__ */ jsx3("div", { style: { color: data.low ? "var(--ui-orange)" : void 0, fontSize: 28, fontVariantNumeric: "tabular-nums", fontWeight: 600, margin: "4px 0 8px" }, children: t("usd", data.credit) }),
      data.low && /* @__PURE__ */ jsx3("p", { style: { color: "var(--ui-orange)", fontSize: 12, margin: "0 0 8px" }, children: t("lowCredit") }),
      /* @__PURE__ */ jsxs3("div", { style: { ...muted, fontSize: 12, lineHeight: 1.7 }, children: [
        /* @__PURE__ */ jsxs3("div", { children: [
          t("topUps"),
          ": ",
          t("usd", data.cumulative_top_up)
        ] }),
        data.has_free_credit && /* @__PURE__ */ jsx3("div", { children: t("freeCredit") })
      ] }),
      /* @__PURE__ */ jsxs3("div", { style: { display: "flex", gap: 8, marginTop: 12 }, children: [
        /* @__PURE__ */ jsx3(Button3, { onClick: () => open(data.links.top_up), children: t("topUp") }),
        /* @__PURE__ */ jsx3(Button3, { onClick: () => open(data.links.keys), variant: "ghost", children: t("apiKeys") })
      ] })
    ] }),
    /* @__PURE__ */ jsxs3("div", { style: card, children: [
      /* @__PURE__ */ jsx3("div", { style: { ...muted, fontSize: 12 }, children: t("plan") }),
      /* @__PURE__ */ jsx3("div", { style: { fontSize: 20, fontWeight: 600, margin: "4px 0 8px", textTransform: data.package_unavailable ? "none" : "capitalize" }, children: data.package_unavailable ? t("planUnavailable") : plan?.type ?? t("noPlan") }),
      plan && /* @__PURE__ */ jsxs3("div", { style: { ...muted, fontSize: 12, lineHeight: 1.7 }, children: [
        typeof plan.total === "number" && /* @__PURE__ */ jsx3("div", { children: t("planBalance", Number(plan.balance ?? 0), plan.total) }),
        plan.finished_at && /* @__PURE__ */ jsx3("div", { children: t(renews(plan) ? "renews" : "periodEnds", String(plan.finished_at).slice(0, 10)) })
      ] }),
      /* @__PURE__ */ jsx3("p", { style: { ...muted, fontSize: 12, lineHeight: 1.5 }, children: t("creditsSeparate") }),
      /* @__PURE__ */ jsx3(Button3, { onClick: () => open(data.links.plans), variant: "secondary", children: t("plans") })
    ] })
  ] });
}

// src/desktop/locales/en.ts
var agentName = (profile) => profile && profile !== "default" ? profile : en.thisAgent;
var en = {
  thisAgent: "this agent",
  title: "Voices",
  navLabel: "Voices",
  paletteVoices: "Fish Audio: Voices",
  paletteAccount: "Fish Audio: Account",
  poweredBy: "Fish Audio",
  forAgent: (profile) => `For ${agentName(profile)}`,
  notSetUp: (profile) => `Fish Audio isn't set up on ${agentName(profile)}'s machine yet. Install the plugin there, enable it, and restart the gateway.`,
  tabs: { library: "Library", mine: "My voices", create: "Create", account: "Account" },
  // Onboarding (no key)
  operatorOnboardTitle: "Voice isn't set up for this agent yet",
  operatorOnboardBody: "Ask the operator of this agent to finish the Fish Audio setup.",
  operatorBilledNote: "Preview plays a short sample.",
  operatorCloneBilled: "Cloning creates a new voice for this agent.",
  operatorDesignBilled: "Each design creates new candidate voices.",
  onboardTitle: "Connect your Fish Audio account",
  onboardBody: (profile) => `Voices need a Fish Audio API key on ${agentName(profile)}. New accounts can start on the free s2.1-pro-free model.`,
  onboardStep1: "Create a free API key on fish.audio",
  onboardStep2: "Paste it in Settings \u25B8 Plugins \u25B8 Fish Audio (in older versions: Capabilities \u25B8 Plugins), then restart the gateway",
  getKey: "Get an API key",
  openPlugins: "Open Plugins",
  checkAgain: "Check again",
  unreachable: (profile) => `Couldn't reach Fish Audio on ${agentName(profile)}`,
  // Library
  search: "Search voices",
  language: "Language",
  anyLanguage: "Any language",
  languages: {
    en: "English",
    zh: "Chinese",
    ja: "Japanese",
    ko: "Korean",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    ru: "Russian",
    ar: "Arabic",
    nl: "Dutch",
    pl: "Polish"
  },
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
  useOtherProvider: (provider) => `Your current TTS provider is ${provider}. Switch with \`hermes tools\` \u25B8 Text-to-Speech \u25B8 Fish Audio.`,
  useProviderByOperator: (provider) => `This agent's speech provider (${provider}) is set by its operator.`,
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
  operatorCloned: (title) => `Created ${title}. Find it in the Library under Favourites.`,
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
  operatorSaved: (title) => `Saved ${title}. Find it in the Library under Favourites.`,
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

// src/desktop/locales/zh.ts
var agentName2 = (profile) => profile && profile !== "default" ? profile : zh.thisAgent;
var zh = {
  thisAgent: "\u6B64\u667A\u80FD\u4F53",
  title: "\u58F0\u97F3",
  navLabel: "\u58F0\u97F3",
  paletteVoices: "Fish Audio\uFF1A\u58F0\u97F3",
  paletteAccount: "Fish Audio\uFF1A\u8D26\u6237",
  poweredBy: "Fish Audio",
  forAgent: (profile) => `\u7528\u4E8E${agentName2(profile)}`,
  notSetUp: (profile) => `${agentName2(profile)}\u6240\u5728\u7684\u673A\u5668\u5C1A\u672A\u8BBE\u7F6E Fish Audio\u3002\u8BF7\u5728\u8BE5\u673A\u5668\u4E0A\u5B89\u88C5\u5E76\u542F\u7528\u63D2\u4EF6\uFF0C\u7136\u540E\u91CD\u542F\u7F51\u5173\u3002`,
  tabs: { library: "\u58F0\u97F3\u5E93", mine: "\u6211\u7684\u58F0\u97F3", create: "\u521B\u5EFA", account: "\u8D26\u6237" },
  operatorOnboardTitle: "\u6B64\u667A\u80FD\u4F53\u5C1A\u672A\u8BBE\u7F6E\u8BED\u97F3\u529F\u80FD",
  operatorOnboardBody: "\u8BF7\u8054\u7CFB\u6B64\u667A\u80FD\u4F53\u7684\u7BA1\u7406\u5458\uFF0C\u5B8C\u6210 Fish Audio \u8BBE\u7F6E\u3002",
  operatorBilledNote: "\u8BD5\u542C\u4F1A\u64AD\u653E\u4E00\u5C0F\u6BB5\u6837\u672C\u3002",
  operatorCloneBilled: "\u514B\u9686\u4F1A\u4E3A\u6B64\u667A\u80FD\u4F53\u521B\u5EFA\u4E00\u4E2A\u65B0\u58F0\u97F3\u3002",
  operatorDesignBilled: "\u6BCF\u6B21\u8BBE\u8BA1\u90FD\u4F1A\u521B\u5EFA\u65B0\u7684\u5019\u9009\u58F0\u97F3\u3002",
  onboardTitle: "\u8FDE\u63A5\u4F60\u7684 Fish Audio \u8D26\u6237",
  onboardBody: (profile) => `\u58F0\u97F3\u529F\u80FD\u9700\u8981\u5728${agentName2(profile)}\u4E0A\u914D\u7F6E Fish Audio API \u5BC6\u94A5\u3002\u65B0\u8D26\u6237\u53EF\u4EE5\u5148\u4F7F\u7528\u514D\u8D39\u7684 s2.1-pro-free \u6A21\u578B\u3002`,
  onboardStep1: "\u5728 fish.audio \u521B\u5EFA\u514D\u8D39 API \u5BC6\u94A5",
  onboardStep2: "\u5C06\u5BC6\u94A5\u7C98\u8D34\u5230\u8BBE\u7F6E \u25B8 \u63D2\u4EF6 \u25B8 Fish Audio\uFF08\u65E7\u7248\u672C\u4E2D\u4E3A\u6280\u80FD\u4E0E\u5DE5\u5177 \u25B8 \u63D2\u4EF6\uFF09\uFF0C\u7136\u540E\u91CD\u542F\u7F51\u5173",
  getKey: "\u83B7\u53D6 API \u5BC6\u94A5",
  openPlugins: "\u6253\u5F00\u63D2\u4EF6",
  checkAgain: "\u518D\u6B21\u68C0\u67E5",
  unreachable: (profile) => `\u65E0\u6CD5\u8FDE\u63A5${agentName2(profile)}\u4E0A\u7684 Fish Audio`,
  search: "\u641C\u7D22\u58F0\u97F3",
  language: "\u8BED\u8A00",
  anyLanguage: "\u6240\u6709\u8BED\u8A00",
  languages: {
    en: "\u82F1\u8BED",
    zh: "\u4E2D\u6587",
    ja: "\u65E5\u8BED",
    ko: "\u97E9\u8BED",
    es: "\u897F\u73ED\u7259\u8BED",
    fr: "\u6CD5\u8BED",
    de: "\u5FB7\u8BED",
    it: "\u610F\u5927\u5229\u8BED",
    pt: "\u8461\u8404\u7259\u8BED",
    ru: "\u4FC4\u8BED",
    ar: "\u963F\u62C9\u4F2F\u8BED",
    nl: "\u8377\u5170\u8BED",
    pl: "\u6CE2\u5170\u8BED"
  },
  favouritesOnly: "\u6536\u85CF",
  billedNote: "\u8BD5\u542C\u4F1A\u64AD\u653E\u4E00\u5C0F\u6BB5\u6837\u672C\uFF0C\u8D39\u7528\u8BA1\u5165\u4F60\u7684 Fish Audio \u8D26\u6237\u3002",
  preview: "\u8BD5\u542C",
  stop: "\u505C\u6B62",
  use: "\u4F7F\u7528",
  inUse: "\u4F7F\u7528\u4E2D",
  favourite: "\u6536\u85CF",
  unfavourite: "\u53D6\u6D88\u6536\u85CF",
  uses: (n) => `\u4F7F\u7528 ${compact2(n)} \u6B21`,
  noVoices: "\u6CA1\u6709\u5339\u914D\u7684\u58F0\u97F3",
  noFavourites: "\u6682\u65E0\u6536\u85CF",
  noFavouritesHint: "\u5728\u58F0\u97F3\u5E93\u4E2D\u70B9\u51FB\u58F0\u97F3\u7684\u661F\u6807\uFF0C\u5373\u53EF\u5C06\u5176\u6536\u85CF\u5230\u8FD9\u91CC\u3002",
  prev: "\u4E0A\u4E00\u9875",
  next: "\u4E0B\u4E00\u9875",
  pageOf: (page) => `\u7B2C ${page} \u9875`,
  usedVoice: (title, profile) => `${agentName2(profile)}\u7684\u58F0\u97F3\u5DF2\u8BBE\u4E3A${title}\u3002`,
  useOtherProvider: (provider) => `\u5F53\u524D\u7684\u6587\u5B57\u8F6C\u8BED\u97F3\u63D0\u4F9B\u65B9\u662F ${provider}\u3002\u53EF\u901A\u8FC7 \`hermes tools\` \u25B8 Text-to-Speech \u25B8 Fish Audio \u5207\u6362\u3002`,
  useProviderByOperator: (provider) => `\u6B64\u667A\u80FD\u4F53\u7684\u6587\u5B57\u8F6C\u8BED\u97F3\u63D0\u4F9B\u65B9\uFF08${provider}\uFF09\u7531\u5176\u7BA1\u7406\u5458\u8BBE\u7F6E\u3002`,
  loadFailed: "\u65E0\u6CD5\u52A0\u8F7D\u58F0\u97F3",
  retry: "\u91CD\u8BD5",
  mineEmpty: "\u4F60\u5C1A\u672A\u521B\u5EFA\u4EFB\u4F55\u58F0\u97F3",
  mineEmptyHint: "\u5728\u201C\u521B\u5EFA\u201D\u4E2D\u514B\u9686\u4F60\u7684\u58F0\u97F3\uFF0C\u6216\u8BBE\u8BA1\u4E00\u4E2A\u65B0\u58F0\u97F3\u3002",
  delete: "\u5220\u9664",
  deleteTitle: (title) => `\u5220\u9664\u201C${title}\u201D\uFF1F`,
  deleteBody: "\u8FD9\u5C06\u4ECE\u4F60\u7684 Fish Audio \u8D26\u6237\u4E2D\u79FB\u9664\u6B64\u58F0\u97F3\u3002\u4F7F\u7528\u6B64\u58F0\u97F3\u7684\u667A\u80FD\u4F53\u9700\u8981\u91CD\u65B0\u9009\u62E9\u5176\u4ED6\u58F0\u97F3\u3002",
  deleteConfirmLabel: (title) => `\u8F93\u5165\u201C${title}\u201D\u4EE5\u786E\u8BA4`,
  cancel: "\u53D6\u6D88",
  deleted: (title) => `\u5DF2\u5220\u9664${title}\u3002`,
  cloneTitle: "\u514B\u9686\u58F0\u97F3",
  cloneBody: "\u4E0A\u4F20\u540C\u4E00\u4F4D\u8BF4\u8BDD\u8005\u7684 1\u20133 \u6BB5\u6E05\u6670\u5F55\u97F3\uFF08MP3\u3001WAV\u3001OGG\u3001WebM\u3001FLAC \u6216 MP4\uFF0C\u6BCF\u4E2A\u6587\u4EF6\u4E0D\u8D85\u8FC7 10 MB\uFF09\u3002",
  chooseFiles: "\u9009\u62E9\u97F3\u9891\u6587\u4EF6",
  voiceTitle: "\u58F0\u97F3\u540D\u79F0",
  descriptionOptional: "\u63CF\u8FF0\uFF08\u53EF\u9009\uFF09",
  consent: "\u6211\u5DF2\u83B7\u5F97\u8BF4\u8BDD\u8005\u7684\u8BB8\u53EF\uFF0C\u53EF\u4EE5\u514B\u9686\u6B64\u58F0\u97F3\u3002",
  clone: "\u514B\u9686\u58F0\u97F3",
  cloneBilled: "\u514B\u9686\u8D39\u7528\u8BA1\u5165\u4F60\u7684 Fish Audio \u8D26\u6237\u3002",
  uploading: (n, total, percent) => `\u6B63\u5728\u4E0A\u4F20\u7B2C ${n}/${total} \u4E2A\u6587\u4EF6 \xB7 ${percent}%`,
  cloning: "\u6B63\u5728\u521B\u5EFA\u58F0\u97F3\u2026",
  cloned: (title) => `\u5DF2\u521B\u5EFA${title}\u3002\u53EF\u5728\u201C\u6211\u7684\u58F0\u97F3\u201D\u4E2D\u627E\u5230\u3002`,
  operatorCloned: (title) => `\u5DF2\u521B\u5EFA${title}\u3002\u53EF\u5728\u58F0\u97F3\u5E93\u7684\u201C\u6536\u85CF\u201D\u4E2D\u627E\u5230\u3002`,
  tooMany: "\u6700\u591A\u9009\u62E9 3 \u4E2A\u6587\u4EF6\u3002",
  tooLarge: (name) => `${name}\u8D85\u8FC7 10 MB\u3002`,
  agentChangedNothingSent: "\u6240\u9009\u667A\u80FD\u4F53\u5DF2\u66F4\u6539\uFF0C\u56E0\u6B64\u672A\u53D1\u9001\u4EFB\u4F55\u5185\u5BB9\u3002",
  agentChanged: "\u6240\u9009\u667A\u80FD\u4F53\u5DF2\u66F4\u6539\uFF0C\u56E0\u6B64\u4E0A\u4F20\u5DF2\u505C\u6B62\u3002\u672A\u5411\u53E6\u4E00\u4E2A\u667A\u80FD\u4F53\u53D1\u9001\u4EFB\u4F55\u5185\u5BB9\u3002",
  designTitle: "\u8BBE\u8BA1\u58F0\u97F3",
  designBody: "\u63CF\u8FF0\u4F60\u60F3\u8981\u7684\u58F0\u97F3\u3002Fish Audio \u4F1A\u751F\u6210\u51E0\u4E2A\u5019\u9009\u58F0\u97F3\u4F9B\u4F60\u9009\u62E9\u3002",
  designPlaceholder: "\u4E00\u4F4D\u56DB\u5341\u591A\u5C81\u7684\u82F1\u56FD\u5973\u6027\u65C1\u767D\uFF0C\u58F0\u97F3\u6E29\u6696\u3001\u4ECE\u5BB9\uFF0C\u7565\u5E26\u6C99\u54D1",
  design: "\u8BBE\u8BA1\u58F0\u97F3",
  designing: "\u6B63\u5728\u8BBE\u8BA1\u2026",
  designBilled: "\u6BCF\u6B21\u8BBE\u8BA1\u7684\u8D39\u7528\u8BA1\u5165\u4F60\u7684 Fish Audio \u8D26\u6237\u3002",
  candidate: (n) => `\u5019\u9009\u58F0\u97F3 ${n}`,
  saveAs: "\u540D\u79F0",
  save: "\u4FDD\u5B58\u58F0\u97F3",
  saved: (title) => `\u5DF2\u4FDD\u5B58${title}\u3002\u53EF\u5728\u201C\u6211\u7684\u58F0\u97F3\u201D\u4E2D\u627E\u5230\u3002`,
  operatorSaved: (title) => `\u5DF2\u4FDD\u5B58${title}\u3002\u53EF\u5728\u58F0\u97F3\u5E93\u7684\u201C\u6536\u85CF\u201D\u4E2D\u627E\u5230\u3002`,
  apiCredit: "API \u989D\u5EA6",
  lowCredit: "\u4F59\u989D\u4E0D\u8DB3\u2014\u2014\u8BF7\u5145\u503C\u4EE5\u7EE7\u7EED\u4F7F\u7528\u8BED\u97F3\u56DE\u590D\u3002",
  topUps: "\u7D2F\u8BA1\u5145\u503C",
  freeCredit: "\u53EF\u7528\u514D\u8D39\u989D\u5EA6",
  plan: "\u5957\u9910",
  planBalance: (balance, total) => `\u5269\u4F59 ${balance.toLocaleString("zh-CN")} / ${total.toLocaleString("zh-CN")} \u79EF\u5206`,
  renews: (date) => `\u7EED\u8BA2\u65E5\u671F\uFF1A${date}`,
  periodEnds: (date) => `\u5F53\u524D\u5468\u671F\u7ED3\u675F\u65E5\u671F\uFF1A${date}`,
  noPlan: "\u65E0\u5E94\u7528\u5957\u9910",
  planUnavailable: "\u6682\u65F6\u65E0\u6CD5\u83B7\u53D6\u5957\u9910\u8BE6\u60C5\u3002",
  creditsSeparate: "\u5E94\u7528\u5957\u9910\u79EF\u5206\u4E0E API \u989D\u5EA6\u76F8\u4E92\u72EC\u7ACB\u3002\u8BED\u97F3\u56DE\u590D\u4F7F\u7528 API \u989D\u5EA6\u3002",
  topUp: "\u5145\u503C API \u989D\u5EA6",
  plans: "\u5957\u9910",
  apiKeys: "API \u5BC6\u94A5",
  chip: (credit) => `Fish ${credit}`,
  chipTip: "Fish Audio API \u989D\u5EA6",
  usd: (value) => `$${Number(value).toFixed(2)}`
};
function compact2(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

// src/desktop/locales/zh-hant.ts
var agentName3 = (profile) => profile && profile !== "default" ? profile : zhHant.thisAgent;
var zhHant = {
  thisAgent: "\u6B64\u4EE3\u7406",
  title: "\u8072\u97F3",
  navLabel: "\u8072\u97F3",
  paletteVoices: "Fish Audio\uFF1A\u8072\u97F3",
  paletteAccount: "Fish Audio\uFF1A\u5E33\u6236",
  poweredBy: "Fish Audio",
  forAgent: (profile) => `\u7528\u65BC${agentName3(profile)}`,
  notSetUp: (profile) => `${agentName3(profile)}\u6240\u5728\u7684\u96FB\u8166\u5C1A\u672A\u8A2D\u5B9A Fish Audio\u3002\u8ACB\u5728\u8A72\u96FB\u8166\u4E0A\u5B89\u88DD\u4E26\u555F\u7528\u5916\u639B\uFF0C\u7136\u5F8C\u91CD\u65B0\u555F\u52D5\u9598\u9053\u3002`,
  tabs: { library: "\u8072\u97F3\u5EAB", mine: "\u6211\u7684\u8072\u97F3", create: "\u5EFA\u7ACB", account: "\u5E33\u6236" },
  operatorOnboardTitle: "\u6B64\u4EE3\u7406\u5C1A\u672A\u8A2D\u5B9A\u8A9E\u97F3\u529F\u80FD",
  operatorOnboardBody: "\u8ACB\u806F\u7D61\u6B64\u4EE3\u7406\u7684\u7BA1\u7406\u54E1\uFF0C\u5B8C\u6210 Fish Audio \u8A2D\u5B9A\u3002",
  operatorBilledNote: "\u8A66\u807D\u6703\u64AD\u653E\u4E00\u5C0F\u6BB5\u7BC4\u4F8B\u3002",
  operatorCloneBilled: "\u514B\u9686\u6703\u70BA\u6B64\u4EE3\u7406\u5EFA\u7ACB\u4E00\u500B\u65B0\u8072\u97F3\u3002",
  operatorDesignBilled: "\u6BCF\u6B21\u8A2D\u8A08\u90FD\u6703\u5EFA\u7ACB\u65B0\u7684\u5019\u9078\u8072\u97F3\u3002",
  onboardTitle: "\u9023\u63A5\u60A8\u7684 Fish Audio \u5E33\u6236",
  onboardBody: (profile) => `\u8072\u97F3\u529F\u80FD\u9700\u8981\u5728${agentName3(profile)}\u4E0A\u8A2D\u5B9A Fish Audio API \u91D1\u9470\u3002\u65B0\u5E33\u6236\u53EF\u4EE5\u5148\u4F7F\u7528\u514D\u8CBB\u7684 s2.1-pro-free \u6A21\u578B\u3002`,
  onboardStep1: "\u5728 fish.audio \u5EFA\u7ACB\u514D\u8CBB API \u91D1\u9470",
  onboardStep2: "\u5C07\u91D1\u9470\u8CBC\u5230\u8A2D\u5B9A \u25B8 \u5916\u639B \u25B8 Fish Audio\uFF08\u820A\u7248\u672C\u4E2D\u70BA\u6280\u80FD\u8207\u5DE5\u5177 \u25B8 \u5916\u639B\uFF09\uFF0C\u7136\u5F8C\u91CD\u65B0\u555F\u52D5\u9598\u9053",
  getKey: "\u53D6\u5F97 API \u91D1\u9470",
  openPlugins: "\u958B\u555F\u5916\u639B",
  checkAgain: "\u518D\u6B21\u6AA2\u67E5",
  unreachable: (profile) => `\u7121\u6CD5\u9023\u7DDA\u81F3${agentName3(profile)}\u4E0A\u7684 Fish Audio`,
  search: "\u641C\u5C0B\u8072\u97F3",
  language: "\u8A9E\u8A00",
  anyLanguage: "\u6240\u6709\u8A9E\u8A00",
  languages: {
    en: "\u82F1\u6587",
    zh: "\u4E2D\u6587",
    ja: "\u65E5\u6587",
    ko: "\u97D3\u6587",
    es: "\u897F\u73ED\u7259\u6587",
    fr: "\u6CD5\u6587",
    de: "\u5FB7\u6587",
    it: "\u7FA9\u5927\u5229\u6587",
    pt: "\u8461\u8404\u7259\u6587",
    ru: "\u4FC4\u6587",
    ar: "\u963F\u62C9\u4F2F\u6587",
    nl: "\u8377\u862D\u6587",
    pl: "\u6CE2\u862D\u6587"
  },
  favouritesOnly: "\u6536\u85CF",
  billedNote: "\u8A66\u807D\u6703\u64AD\u653E\u4E00\u5C0F\u6BB5\u7BC4\u4F8B\uFF0C\u8CBB\u7528\u8A08\u5165\u60A8\u7684 Fish Audio \u5E33\u6236\u3002",
  preview: "\u8A66\u807D",
  stop: "\u505C\u6B62",
  use: "\u4F7F\u7528",
  inUse: "\u4F7F\u7528\u4E2D",
  favourite: "\u6536\u85CF",
  unfavourite: "\u53D6\u6D88\u6536\u85CF",
  uses: (n) => `\u4F7F\u7528 ${compact3(n)} \u6B21`,
  noVoices: "\u6C92\u6709\u7B26\u5408\u7684\u8072\u97F3",
  noFavourites: "\u5C1A\u7121\u6536\u85CF",
  noFavouritesHint: "\u5728\u8072\u97F3\u5EAB\u4E2D\u9EDE\u9078\u8072\u97F3\u7684\u661F\u865F\uFF0C\u5373\u53EF\u5C07\u5176\u6536\u85CF\u5230\u9019\u88E1\u3002",
  prev: "\u4E0A\u4E00\u9801",
  next: "\u4E0B\u4E00\u9801",
  pageOf: (page) => `\u7B2C ${page} \u9801`,
  usedVoice: (title, profile) => `${agentName3(profile)}\u7684\u8072\u97F3\u5DF2\u8A2D\u70BA${title}\u3002`,
  useOtherProvider: (provider) => `\u76EE\u524D\u7684\u6587\u5B57\u8F49\u8A9E\u97F3\u63D0\u4F9B\u65B9\u662F ${provider}\u3002\u53EF\u900F\u904E \`hermes tools\` \u25B8 Text-to-Speech \u25B8 Fish Audio \u5207\u63DB\u3002`,
  useProviderByOperator: (provider) => `\u6B64\u4EE3\u7406\u7684\u6587\u5B57\u8F49\u8A9E\u97F3\u63D0\u4F9B\u65B9\uFF08${provider}\uFF09\u7531\u5176\u7BA1\u7406\u54E1\u8A2D\u5B9A\u3002`,
  loadFailed: "\u7121\u6CD5\u8F09\u5165\u8072\u97F3",
  retry: "\u91CD\u8A66",
  mineEmpty: "\u60A8\u5C1A\u672A\u5EFA\u7ACB\u4EFB\u4F55\u8072\u97F3",
  mineEmptyHint: "\u5728\u300C\u5EFA\u7ACB\u300D\u4E2D\u514B\u9686\u60A8\u7684\u8072\u97F3\uFF0C\u6216\u8A2D\u8A08\u4E00\u500B\u65B0\u8072\u97F3\u3002",
  delete: "\u522A\u9664",
  deleteTitle: (title) => `\u522A\u9664\u300C${title}\u300D\uFF1F`,
  deleteBody: "\u9019\u5C07\u5F9E\u60A8\u7684 Fish Audio \u5E33\u6236\u4E2D\u79FB\u9664\u6B64\u8072\u97F3\u3002\u4F7F\u7528\u6B64\u8072\u97F3\u7684\u4EE3\u7406\u9700\u8981\u91CD\u65B0\u9078\u64C7\u5176\u4ED6\u8072\u97F3\u3002",
  deleteConfirmLabel: (title) => `\u8F38\u5165\u300C${title}\u300D\u4EE5\u78BA\u8A8D`,
  cancel: "\u53D6\u6D88",
  deleted: (title) => `\u5DF2\u522A\u9664${title}\u3002`,
  cloneTitle: "\u514B\u9686\u8072\u97F3",
  cloneBody: "\u4E0A\u50B3\u540C\u4E00\u4F4D\u8AAA\u8A71\u8005\u7684 1\u20133 \u6BB5\u6E05\u6670\u9304\u97F3\uFF08MP3\u3001WAV\u3001OGG\u3001WebM\u3001FLAC \u6216 MP4\uFF0C\u6BCF\u500B\u6A94\u6848\u4E0D\u8D85\u904E 10 MB\uFF09\u3002",
  chooseFiles: "\u9078\u64C7\u97F3\u8A0A\u6A94\u6848",
  voiceTitle: "\u8072\u97F3\u540D\u7A31",
  descriptionOptional: "\u63CF\u8FF0\uFF08\u9078\u586B\uFF09",
  consent: "\u6211\u5DF2\u53D6\u5F97\u8AAA\u8A71\u8005\u7684\u8A31\u53EF\uFF0C\u53EF\u4EE5\u514B\u9686\u6B64\u8072\u97F3\u3002",
  clone: "\u514B\u9686\u8072\u97F3",
  cloneBilled: "\u514B\u9686\u8CBB\u7528\u8A08\u5165\u60A8\u7684 Fish Audio \u5E33\u6236\u3002",
  uploading: (n, total, percent) => `\u6B63\u5728\u4E0A\u50B3\u7B2C ${n}/${total} \u500B\u6A94\u6848 \xB7 ${percent}%`,
  cloning: "\u6B63\u5728\u5EFA\u7ACB\u8072\u97F3\u2026",
  cloned: (title) => `\u5DF2\u5EFA\u7ACB${title}\u3002\u53EF\u5728\u300C\u6211\u7684\u8072\u97F3\u300D\u4E2D\u627E\u5230\u3002`,
  operatorCloned: (title) => `\u5DF2\u5EFA\u7ACB${title}\u3002\u53EF\u5728\u8072\u97F3\u5EAB\u7684\u300C\u6536\u85CF\u300D\u4E2D\u627E\u5230\u3002`,
  tooMany: "\u6700\u591A\u9078\u64C7 3 \u500B\u6A94\u6848\u3002",
  tooLarge: (name) => `${name}\u8D85\u904E 10 MB\u3002`,
  agentChangedNothingSent: "\u6240\u9078\u4EE3\u7406\u5DF2\u8B8A\u66F4\uFF0C\u56E0\u6B64\u672A\u50B3\u9001\u4EFB\u4F55\u5167\u5BB9\u3002",
  agentChanged: "\u6240\u9078\u4EE3\u7406\u5DF2\u8B8A\u66F4\uFF0C\u56E0\u6B64\u4E0A\u50B3\u5DF2\u505C\u6B62\u3002\u672A\u5411\u53E6\u4E00\u500B\u4EE3\u7406\u50B3\u9001\u4EFB\u4F55\u5167\u5BB9\u3002",
  designTitle: "\u8A2D\u8A08\u8072\u97F3",
  designBody: "\u63CF\u8FF0\u60A8\u60F3\u8981\u7684\u8072\u97F3\u3002Fish Audio \u6703\u7522\u751F\u5E7E\u500B\u5019\u9078\u8072\u97F3\u4F9B\u60A8\u9078\u64C7\u3002",
  designPlaceholder: "\u4E00\u4F4D\u56DB\u5341\u591A\u6B72\u7684\u82F1\u570B\u5973\u6027\u65C1\u767D\uFF0C\u8072\u97F3\u6EAB\u6696\u3001\u5F9E\u5BB9\uFF0C\u7565\u5E36\u6C99\u555E",
  design: "\u8A2D\u8A08\u8072\u97F3",
  designing: "\u6B63\u5728\u8A2D\u8A08\u2026",
  designBilled: "\u6BCF\u6B21\u8A2D\u8A08\u7684\u8CBB\u7528\u8A08\u5165\u60A8\u7684 Fish Audio \u5E33\u6236\u3002",
  candidate: (n) => `\u5019\u9078\u8072\u97F3 ${n}`,
  saveAs: "\u540D\u7A31",
  save: "\u5132\u5B58\u8072\u97F3",
  saved: (title) => `\u5DF2\u5132\u5B58${title}\u3002\u53EF\u5728\u300C\u6211\u7684\u8072\u97F3\u300D\u4E2D\u627E\u5230\u3002`,
  operatorSaved: (title) => `\u5DF2\u5132\u5B58${title}\u3002\u53EF\u5728\u8072\u97F3\u5EAB\u7684\u300C\u6536\u85CF\u300D\u4E2D\u627E\u5230\u3002`,
  apiCredit: "API \u984D\u5EA6",
  lowCredit: "\u9918\u984D\u4E0D\u8DB3\u2014\u2014\u8ACB\u5132\u503C\u4EE5\u7E7C\u7E8C\u4F7F\u7528\u8A9E\u97F3\u56DE\u8986\u3002",
  topUps: "\u7D2F\u8A08\u5132\u503C",
  freeCredit: "\u53EF\u7528\u514D\u8CBB\u984D\u5EA6",
  plan: "\u65B9\u6848",
  planBalance: (balance, total) => `\u5269\u9918 ${balance.toLocaleString("zh-TW")} / ${total.toLocaleString("zh-TW")} \u9EDE\u6578`,
  renews: (date) => `\u7E8C\u8A02\u65E5\u671F\uFF1A${date}`,
  periodEnds: (date) => `\u76EE\u524D\u9031\u671F\u7D50\u675F\u65E5\u671F\uFF1A${date}`,
  noPlan: "\u7121\u61C9\u7528\u7A0B\u5F0F\u65B9\u6848",
  planUnavailable: "\u76EE\u524D\u7121\u6CD5\u53D6\u5F97\u65B9\u6848\u8A73\u7D30\u8CC7\u8A0A\u3002",
  creditsSeparate: "\u61C9\u7528\u7A0B\u5F0F\u65B9\u6848\u9EDE\u6578\u8207 API \u984D\u5EA6\u4E92\u76F8\u7368\u7ACB\u3002\u8A9E\u97F3\u56DE\u8986\u4F7F\u7528 API \u984D\u5EA6\u3002",
  topUp: "\u5132\u503C API \u984D\u5EA6",
  plans: "\u65B9\u6848",
  apiKeys: "API \u91D1\u9470",
  chip: (credit) => `Fish ${credit}`,
  chipTip: "Fish Audio API \u984D\u5EA6",
  usd: (value) => `$${Number(value).toFixed(2)}`
};
function compact3(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

// src/desktop/locales/ja.ts
var agentName4 = (profile) => profile && profile !== "default" ? profile : ja.thisAgent;
var ja = {
  thisAgent: "\u3053\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8",
  title: "\u30DC\u30A4\u30B9",
  navLabel: "\u30DC\u30A4\u30B9",
  paletteVoices: "Fish Audio\uFF1A\u30DC\u30A4\u30B9",
  paletteAccount: "Fish Audio\uFF1A\u30A2\u30AB\u30A6\u30F3\u30C8",
  poweredBy: "Fish Audio",
  forAgent: (profile) => `${agentName4(profile)}\u7528`,
  notSetUp: (profile) => `${agentName4(profile)}\u306E\u30DE\u30B7\u30F3\u3067\u306F Fish Audio \u304C\u307E\u3060\u8A2D\u5B9A\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002\u305D\u306E\u30DE\u30B7\u30F3\u306B\u30D7\u30E9\u30B0\u30A4\u30F3\u3092\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u3057\u3066\u6709\u52B9\u306B\u3057\u3001\u30B2\u30FC\u30C8\u30A6\u30A7\u30A4\u3092\u518D\u8D77\u52D5\u3057\u3066\u304F\u3060\u3055\u3044\u3002`,
  tabs: { library: "\u30E9\u30A4\u30D6\u30E9\u30EA", mine: "\u30DE\u30A4\u30DC\u30A4\u30B9", create: "\u4F5C\u6210", account: "\u30A2\u30AB\u30A6\u30F3\u30C8" },
  operatorOnboardTitle: "\u3053\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u306E\u97F3\u58F0\u6A5F\u80FD\u306F\u307E\u3060\u8A2D\u5B9A\u3055\u308C\u3066\u3044\u307E\u305B\u3093",
  operatorOnboardBody: "\u3053\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u306E\u904B\u7528\u8005\u306B Fish Audio \u306E\u8A2D\u5B9A\u3092\u5B8C\u4E86\u3059\u308B\u3088\u3046\u4F9D\u983C\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  operatorBilledNote: "\u8A66\u8074\u3067\u306F\u77ED\u3044\u30B5\u30F3\u30D7\u30EB\u304C\u518D\u751F\u3055\u308C\u307E\u3059\u3002",
  operatorCloneBilled: "\u30AF\u30ED\u30FC\u30F3\u4F5C\u6210\u3067\u306F\u3001\u3053\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u7528\u306E\u65B0\u3057\u3044\u30DC\u30A4\u30B9\u304C\u4F5C\u6210\u3055\u308C\u307E\u3059\u3002",
  operatorDesignBilled: "\u30C7\u30B6\u30A4\u30F3\u306E\u305F\u3073\u306B\u65B0\u3057\u3044\u30DC\u30A4\u30B9\u5019\u88DC\u304C\u4F5C\u6210\u3055\u308C\u307E\u3059\u3002",
  onboardTitle: "Fish Audio \u30A2\u30AB\u30A6\u30F3\u30C8\u3092\u63A5\u7D9A",
  onboardBody: (profile) => `\u30DC\u30A4\u30B9\u3092\u4F7F\u3046\u306B\u306F\u3001${agentName4(profile)}\u306B Fish Audio API \u30AD\u30FC\u304C\u5FC5\u8981\u3067\u3059\u3002\u65B0\u3057\u3044\u30A2\u30AB\u30A6\u30F3\u30C8\u3067\u306F\u3001\u7121\u6599\u306E s2.1-pro-free \u30E2\u30C7\u30EB\u304B\u3089\u59CB\u3081\u3089\u308C\u307E\u3059\u3002`,
  onboardStep1: "fish.audio \u3067\u7121\u6599\u306E API \u30AD\u30FC\u3092\u4F5C\u6210",
  onboardStep2: "\u8A2D\u5B9A \u25B8 \u30D7\u30E9\u30B0\u30A4\u30F3 \u25B8 Fish Audio\uFF08\u65E7\u30D0\u30FC\u30B8\u30E7\u30F3\u3067\u306F \u30B9\u30AD\u30EB\u3068\u30C4\u30FC\u30EB \u25B8 \u30D7\u30E9\u30B0\u30A4\u30F3\uFF09\u306B\u30AD\u30FC\u3092\u8CBC\u308A\u4ED8\u3051\u3001\u30B2\u30FC\u30C8\u30A6\u30A7\u30A4\u3092\u518D\u8D77\u52D5",
  getKey: "API \u30AD\u30FC\u3092\u53D6\u5F97",
  openPlugins: "\u30D7\u30E9\u30B0\u30A4\u30F3\u3092\u958B\u304F",
  checkAgain: "\u518D\u78BA\u8A8D",
  unreachable: (profile) => `${agentName4(profile)}\u306E Fish Audio \u306B\u63A5\u7D9A\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F`,
  search: "\u30DC\u30A4\u30B9\u3092\u691C\u7D22",
  language: "\u8A00\u8A9E",
  anyLanguage: "\u3059\u3079\u3066\u306E\u8A00\u8A9E",
  languages: {
    en: "\u82F1\u8A9E",
    zh: "\u4E2D\u56FD\u8A9E",
    ja: "\u65E5\u672C\u8A9E",
    ko: "\u97D3\u56FD\u8A9E",
    es: "\u30B9\u30DA\u30A4\u30F3\u8A9E",
    fr: "\u30D5\u30E9\u30F3\u30B9\u8A9E",
    de: "\u30C9\u30A4\u30C4\u8A9E",
    it: "\u30A4\u30BF\u30EA\u30A2\u8A9E",
    pt: "\u30DD\u30EB\u30C8\u30AC\u30EB\u8A9E",
    ru: "\u30ED\u30B7\u30A2\u8A9E",
    ar: "\u30A2\u30E9\u30D3\u30A2\u8A9E",
    nl: "\u30AA\u30E9\u30F3\u30C0\u8A9E",
    pl: "\u30DD\u30FC\u30E9\u30F3\u30C9\u8A9E"
  },
  favouritesOnly: "\u304A\u6C17\u306B\u5165\u308A",
  billedNote: "\u8A66\u8074\u3067\u306F\u77ED\u3044\u30B5\u30F3\u30D7\u30EB\u304C\u518D\u751F\u3055\u308C\u3001Fish Audio \u30A2\u30AB\u30A6\u30F3\u30C8\u306B\u8AB2\u91D1\u3055\u308C\u307E\u3059\u3002",
  preview: "\u8A66\u8074",
  stop: "\u505C\u6B62",
  use: "\u4F7F\u7528",
  inUse: "\u4F7F\u7528\u4E2D",
  favourite: "\u304A\u6C17\u306B\u5165\u308A\u306B\u8FFD\u52A0",
  unfavourite: "\u304A\u6C17\u306B\u5165\u308A\u304B\u3089\u524A\u9664",
  uses: (n) => `\u4F7F\u7528 ${compact4(n)} \u56DE`,
  noVoices: "\u4E00\u81F4\u3059\u308B\u30DC\u30A4\u30B9\u304C\u3042\u308A\u307E\u305B\u3093",
  noFavourites: "\u304A\u6C17\u306B\u5165\u308A\u306F\u307E\u3060\u3042\u308A\u307E\u305B\u3093",
  noFavouritesHint: "\u30E9\u30A4\u30D6\u30E9\u30EA\u306E\u30DC\u30A4\u30B9\u306B\u661F\u3092\u4ED8\u3051\u308B\u3068\u3001\u3053\u3053\u306B\u4FDD\u5B58\u3055\u308C\u307E\u3059\u3002",
  prev: "\u524D\u3078",
  next: "\u6B21\u3078",
  pageOf: (page) => `${page} \u30DA\u30FC\u30B8`,
  usedVoice: (title, profile) => `${agentName4(profile)}\u306E\u30DC\u30A4\u30B9\u3092\u300C${title}\u300D\u306B\u8A2D\u5B9A\u3057\u307E\u3057\u305F\u3002`,
  useOtherProvider: (provider) => `\u73FE\u5728\u306E\u97F3\u58F0\u5408\u6210\u30D7\u30ED\u30D0\u30A4\u30C0\u30FC\u306F ${provider} \u3067\u3059\u3002\`hermes tools\` \u25B8 Text-to-Speech \u25B8 Fish Audio \u3067\u5207\u308A\u66FF\u3048\u3089\u308C\u307E\u3059\u3002`,
  useProviderByOperator: (provider) => `\u3053\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u306E\u97F3\u58F0\u5408\u6210\u30D7\u30ED\u30D0\u30A4\u30C0\u30FC\uFF08${provider}\uFF09\u306F\u904B\u7528\u8005\u304C\u8A2D\u5B9A\u3057\u3066\u3044\u307E\u3059\u3002`,
  loadFailed: "\u30DC\u30A4\u30B9\u3092\u8AAD\u307F\u8FBC\u3081\u307E\u305B\u3093\u3067\u3057\u305F",
  retry: "\u518D\u8A66\u884C",
  mineEmpty: "\u30DC\u30A4\u30B9\u306F\u307E\u3060\u4F5C\u6210\u3055\u308C\u3066\u3044\u307E\u305B\u3093",
  mineEmptyHint: "\u300C\u4F5C\u6210\u300D\u3067\u81EA\u5206\u306E\u58F0\u3092\u30AF\u30ED\u30FC\u30F3\u3059\u308B\u304B\u3001\u65B0\u3057\u3044\u30DC\u30A4\u30B9\u3092\u30C7\u30B6\u30A4\u30F3\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  delete: "\u524A\u9664",
  deleteTitle: (title) => `\u300C${title}\u300D\u3092\u524A\u9664\u3057\u307E\u3059\u304B\uFF1F`,
  deleteBody: "\u3053\u306E\u30DC\u30A4\u30B9\u306F Fish Audio \u30A2\u30AB\u30A6\u30F3\u30C8\u304B\u3089\u524A\u9664\u3055\u308C\u307E\u3059\u3002\u3053\u306E\u30DC\u30A4\u30B9\u3092\u4F7F\u7528\u3057\u3066\u3044\u308B\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u306B\u306F\u3001\u5225\u306E\u30DC\u30A4\u30B9\u3092\u9078\u629E\u3059\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059\u3002",
  deleteConfirmLabel: (title) => `\u78BA\u8A8D\u306E\u305F\u3081\u300C${title}\u300D\u3068\u5165\u529B`,
  cancel: "\u30AD\u30E3\u30F3\u30BB\u30EB",
  deleted: (title) => `\u300C${title}\u300D\u3092\u524A\u9664\u3057\u307E\u3057\u305F\u3002`,
  cloneTitle: "\u30DC\u30A4\u30B9\u3092\u30AF\u30ED\u30FC\u30F3",
  cloneBody: "\u540C\u3058\u8A71\u8005\u306E\u660E\u77AD\u306A\u9332\u97F3\u3092 1\uFF5E3 \u4EF6\u30A2\u30C3\u30D7\u30ED\u30FC\u30C9\u3057\u3066\u304F\u3060\u3055\u3044\uFF08MP3\u3001WAV\u3001OGG\u3001WebM\u3001FLAC\u3001MP4\u3002\u5404\u30D5\u30A1\u30A4\u30EB\u306F 10 MB \u4EE5\u4E0B\uFF09\u3002",
  chooseFiles: "\u97F3\u58F0\u30D5\u30A1\u30A4\u30EB\u3092\u9078\u629E",
  voiceTitle: "\u30DC\u30A4\u30B9\u540D",
  descriptionOptional: "\u8AAC\u660E\uFF08\u4EFB\u610F\uFF09",
  consent: "\u3053\u306E\u58F0\u3092\u30AF\u30ED\u30FC\u30F3\u3059\u308B\u8A31\u53EF\u3092\u8A71\u8005\u304B\u3089\u5F97\u3066\u3044\u307E\u3059\u3002",
  clone: "\u30DC\u30A4\u30B9\u3092\u30AF\u30ED\u30FC\u30F3",
  cloneBilled: "\u30AF\u30ED\u30FC\u30F3\u4F5C\u6210\u306F Fish Audio \u30A2\u30AB\u30A6\u30F3\u30C8\u306B\u8AB2\u91D1\u3055\u308C\u307E\u3059\u3002",
  uploading: (n, total, percent) => `\u30A2\u30C3\u30D7\u30ED\u30FC\u30C9\u4E2D ${n}/${total} \u4EF6 \xB7 ${percent}%`,
  cloning: "\u30DC\u30A4\u30B9\u3092\u4F5C\u6210\u4E2D\u2026",
  cloned: (title) => `\u300C${title}\u300D\u3092\u4F5C\u6210\u3057\u307E\u3057\u305F\u3002\u300C\u30DE\u30A4\u30DC\u30A4\u30B9\u300D\u3067\u78BA\u8A8D\u3067\u304D\u307E\u3059\u3002`,
  operatorCloned: (title) => `\u300C${title}\u300D\u3092\u4F5C\u6210\u3057\u307E\u3057\u305F\u3002\u30E9\u30A4\u30D6\u30E9\u30EA\u306E\u300C\u304A\u6C17\u306B\u5165\u308A\u300D\u3067\u78BA\u8A8D\u3067\u304D\u307E\u3059\u3002`,
  tooMany: "\u9078\u629E\u3067\u304D\u308B\u30D5\u30A1\u30A4\u30EB\u306F 3 \u4EF6\u307E\u3067\u3067\u3059\u3002",
  tooLarge: (name) => `${name} \u306F 10 MB \u3092\u8D85\u3048\u3066\u3044\u307E\u3059\u3002`,
  agentChangedNothingSent: "\u9078\u629E\u4E2D\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u304C\u5909\u66F4\u3055\u308C\u305F\u305F\u3081\u3001\u4F55\u3082\u9001\u4FE1\u3055\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
  agentChanged: "\u9078\u629E\u4E2D\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u304C\u5909\u66F4\u3055\u308C\u305F\u305F\u3081\u3001\u30A2\u30C3\u30D7\u30ED\u30FC\u30C9\u3092\u505C\u6B62\u3057\u307E\u3057\u305F\u3002\u5225\u306E\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u306B\u306F\u4F55\u3082\u9001\u4FE1\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002",
  designTitle: "\u30DC\u30A4\u30B9\u3092\u30C7\u30B6\u30A4\u30F3",
  designBody: "\u5E0C\u671B\u3059\u308B\u58F0\u3092\u8AAC\u660E\u3057\u3066\u304F\u3060\u3055\u3044\u3002Fish Audio \u304C\u9078\u629E\u3067\u304D\u308B\u30DC\u30A4\u30B9\u5019\u88DC\u3092\u3044\u304F\u3064\u304B\u4F5C\u6210\u3057\u307E\u3059\u3002",
  designPlaceholder: "40 \u4EE3\u306E\u30A4\u30AE\u30EA\u30B9\u4EBA\u5973\u6027\u30CA\u30EC\u30FC\u30BF\u30FC\u3002\u6E29\u304B\u307F\u304C\u3042\u308A\u3001\u3086\u3063\u305F\u308A\u3068\u3057\u305F\u3001\u5C11\u3057\u304B\u3059\u308C\u305F\u58F0",
  design: "\u30DC\u30A4\u30B9\u3092\u30C7\u30B6\u30A4\u30F3",
  designing: "\u30C7\u30B6\u30A4\u30F3\u4E2D\u2026",
  designBilled: "\u30C7\u30B6\u30A4\u30F3\u306E\u305F\u3073\u306B Fish Audio \u30A2\u30AB\u30A6\u30F3\u30C8\u306B\u8AB2\u91D1\u3055\u308C\u307E\u3059\u3002",
  candidate: (n) => `\u5019\u88DC ${n}`,
  saveAs: "\u540D\u524D",
  save: "\u30DC\u30A4\u30B9\u3092\u4FDD\u5B58",
  saved: (title) => `\u300C${title}\u300D\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F\u3002\u300C\u30DE\u30A4\u30DC\u30A4\u30B9\u300D\u3067\u78BA\u8A8D\u3067\u304D\u307E\u3059\u3002`,
  operatorSaved: (title) => `\u300C${title}\u300D\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F\u3002\u30E9\u30A4\u30D6\u30E9\u30EA\u306E\u300C\u304A\u6C17\u306B\u5165\u308A\u300D\u3067\u78BA\u8A8D\u3067\u304D\u307E\u3059\u3002`,
  apiCredit: "API \u30AF\u30EC\u30B8\u30C3\u30C8",
  lowCredit: "\u6B8B\u9AD8\u304C\u5C11\u306A\u304F\u306A\u3063\u3066\u3044\u307E\u3059\u3002\u97F3\u58F0\u8FD4\u4FE1\u3092\u4F7F\u3044\u7D9A\u3051\u308B\u306B\u306F\u30C1\u30E3\u30FC\u30B8\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  topUps: "\u7D2F\u8A08\u30C1\u30E3\u30FC\u30B8\u984D",
  freeCredit: "\u5229\u7528\u53EF\u80FD\u306A\u7121\u6599\u30AF\u30EC\u30B8\u30C3\u30C8",
  plan: "\u30D7\u30E9\u30F3",
  planBalance: (balance, total) => `${total.toLocaleString("ja")} \u30AF\u30EC\u30B8\u30C3\u30C8\u4E2D\u3001\u6B8B\u308A ${balance.toLocaleString("ja")}`,
  renews: (date) => `\u66F4\u65B0\u65E5\uFF1A${date}`,
  periodEnds: (date) => `\u73FE\u5728\u306E\u671F\u9593\u306E\u7D42\u4E86\u65E5\uFF1A${date}`,
  noPlan: "\u30A2\u30D7\u30EA\u306E\u30D7\u30E9\u30F3\u306A\u3057",
  planUnavailable: "\u73FE\u5728\u3001\u30D7\u30E9\u30F3\u306E\u8A73\u7D30\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3002",
  creditsSeparate: "\u30A2\u30D7\u30EA\u306E\u30D7\u30E9\u30F3\u306E\u30AF\u30EC\u30B8\u30C3\u30C8\u3068 API \u30AF\u30EC\u30B8\u30C3\u30C8\u306F\u5225\u3067\u3059\u3002\u97F3\u58F0\u8FD4\u4FE1\u306B\u306F API \u30AF\u30EC\u30B8\u30C3\u30C8\u304C\u4F7F\u308F\u308C\u307E\u3059\u3002",
  topUp: "API \u30AF\u30EC\u30B8\u30C3\u30C8\u3092\u30C1\u30E3\u30FC\u30B8",
  plans: "\u30D7\u30E9\u30F3",
  apiKeys: "API \u30AD\u30FC",
  chip: (credit) => `Fish ${credit}`,
  chipTip: "Fish Audio API \u30AF\u30EC\u30B8\u30C3\u30C8",
  usd: (value) => `$${Number(value).toFixed(2)}`
};
function compact4(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

// src/desktop/locales/ar.ts
var agentName5 = (profile) => profile && profile !== "default" ? profile : ar.thisAgent;
var ar = {
  thisAgent: "\u0647\u0630\u0627 \u0627\u0644\u0648\u0643\u064A\u0644",
  title: "\u0627\u0644\u0623\u0635\u0648\u0627\u062A",
  navLabel: "\u0627\u0644\u0623\u0635\u0648\u0627\u062A",
  paletteVoices: "Fish Audio: \u0627\u0644\u0623\u0635\u0648\u0627\u062A",
  paletteAccount: "Fish Audio: \u0627\u0644\u062D\u0633\u0627\u0628",
  poweredBy: "Fish Audio",
  forAgent: (profile) => profile && profile !== "default" ? `\u0644\u0644\u0648\u0643\u064A\u0644 ${profile}` : "\u0644\u0647\u0630\u0627 \u0627\u0644\u0648\u0643\u064A\u0644",
  notSetUp: (profile) => `\u0644\u0645 \u064A\u062A\u0645 \u0625\u0639\u062F\u0627\u062F Fish Audio \u0639\u0644\u0649 \u062C\u0647\u0627\u0632 ${agentName5(profile)} \u0628\u0639\u062F. \u062B\u0628\u0651\u062A \u0627\u0644\u0625\u0636\u0627\u0641\u0629 \u0647\u0646\u0627\u0643\u060C \u0648\u0641\u0639\u0651\u0644\u0647\u0627\u060C \u062B\u0645 \u0623\u0639\u062F \u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0628\u0648\u0627\u0628\u0629.`,
  tabs: { library: "\u0627\u0644\u0645\u0643\u062A\u0628\u0629", mine: "\u0623\u0635\u0648\u0627\u062A\u064A", create: "\u0625\u0646\u0634\u0627\u0621", account: "\u0627\u0644\u062D\u0633\u0627\u0628" },
  operatorOnboardTitle: "\u0644\u0645 \u064A\u062A\u0645 \u0625\u0639\u062F\u0627\u062F \u0627\u0644\u0635\u0648\u062A \u0644\u0647\u0630\u0627 \u0627\u0644\u0648\u0643\u064A\u0644 \u0628\u0639\u062F",
  operatorOnboardBody: "\u0627\u0637\u0644\u0628 \u0645\u0646 \u0645\u0634\u063A\u0651\u0644 \u0647\u0630\u0627 \u0627\u0644\u0648\u0643\u064A\u0644 \u0625\u0643\u0645\u0627\u0644 \u0625\u0639\u062F\u0627\u062F Fish Audio.",
  operatorBilledNote: "\u062A\u0634\u063A\u0651\u0644 \u0627\u0644\u0645\u0639\u0627\u064A\u0646\u0629 \u0639\u064A\u0646\u0629 \u0642\u0635\u064A\u0631\u0629.",
  operatorCloneBilled: "\u064A\u0646\u0634\u0626 \u0627\u0644\u0627\u0633\u062A\u0646\u0633\u0627\u062E \u0635\u0648\u062A\u064B\u0627 \u062C\u062F\u064A\u062F\u064B\u0627 \u0644\u0647\u0630\u0627 \u0627\u0644\u0648\u0643\u064A\u0644.",
  operatorDesignBilled: "\u064A\u0646\u0634\u0626 \u0643\u0644 \u062A\u0635\u0645\u064A\u0645 \u0623\u0635\u0648\u0627\u062A\u064B\u0627 \u0645\u0631\u0634\u062D\u0629 \u062C\u062F\u064A\u062F\u0629.",
  onboardTitle: "\u0627\u0631\u0628\u0637 \u062D\u0633\u0627\u0628\u0643 \u0641\u064A Fish Audio",
  onboardBody: (profile) => `\u062A\u062D\u062A\u0627\u062C \u0627\u0644\u0623\u0635\u0648\u0627\u062A \u0625\u0644\u0649 \u0645\u0641\u062A\u0627\u062D API \u0644\u0640 Fish Audio \u0644\u062F\u0649 ${agentName5(profile)}. \u064A\u0645\u0643\u0646 \u0644\u0644\u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u062C\u062F\u064A\u062F\u0629 \u0627\u0644\u0628\u062F\u0621 \u0628\u0627\u0644\u0646\u0645\u0648\u0630\u062C \u0627\u0644\u0645\u062C\u0627\u0646\u064A s2.1-pro-free.`,
  onboardStep1: "\u0623\u0646\u0634\u0626 \u0645\u0641\u062A\u0627\u062D API \u0645\u062C\u0627\u0646\u064A\u064B\u0627 \u0639\u0644\u0649 fish.audio",
  onboardStep2: "\u0627\u0644\u0635\u0642\u0647 \u0641\u064A \u0627\u0644\u0625\u0639\u062F\u0627\u062F\u0627\u062A \u25B8 \u0627\u0644\u0625\u0636\u0627\u0641\u0627\u062A \u25B8 Fish Audio (\u0641\u064A \u0627\u0644\u0625\u0635\u062F\u0627\u0631\u0627\u062A \u0627\u0644\u0623\u0642\u062F\u0645: \u0627\u0644\u0645\u0647\u0627\u0631\u0627\u062A \u25B8 \u0627\u0644\u0625\u0636\u0627\u0641\u0627\u062A)\u060C \u062B\u0645 \u0623\u0639\u062F \u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0628\u0648\u0627\u0628\u0629",
  getKey: "\u0627\u0644\u062D\u0635\u0648\u0644 \u0639\u0644\u0649 \u0645\u0641\u062A\u0627\u062D API",
  openPlugins: "\u0641\u062A\u062D \u0627\u0644\u0625\u0636\u0627\u0641\u0627\u062A",
  checkAgain: "\u0627\u0644\u062A\u062D\u0642\u0642 \u0645\u062C\u062F\u062F\u064B\u0627",
  unreachable: (profile) => `\u062A\u0639\u0630\u0631 \u0627\u0644\u0648\u0635\u0648\u0644 \u0625\u0644\u0649 Fish Audio \u0644\u062F\u0649 ${agentName5(profile)}`,
  search: "\u0627\u0644\u0628\u062D\u062B \u0639\u0646 \u0623\u0635\u0648\u0627\u062A",
  language: "\u0627\u0644\u0644\u063A\u0629",
  anyLanguage: "\u0623\u064A \u0644\u063A\u0629",
  languages: {
    en: "\u0627\u0644\u0625\u0646\u062C\u0644\u064A\u0632\u064A\u0629",
    zh: "\u0627\u0644\u0635\u064A\u0646\u064A\u0629",
    ja: "\u0627\u0644\u064A\u0627\u0628\u0627\u0646\u064A\u0629",
    ko: "\u0627\u0644\u0643\u0648\u0631\u064A\u0629",
    es: "\u0627\u0644\u0625\u0633\u0628\u0627\u0646\u064A\u0629",
    fr: "\u0627\u0644\u0641\u0631\u0646\u0633\u064A\u0629",
    de: "\u0627\u0644\u0623\u0644\u0645\u0627\u0646\u064A\u0629",
    it: "\u0627\u0644\u0625\u064A\u0637\u0627\u0644\u064A\u0629",
    pt: "\u0627\u0644\u0628\u0631\u062A\u063A\u0627\u0644\u064A\u0629",
    ru: "\u0627\u0644\u0631\u0648\u0633\u064A\u0629",
    ar: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629",
    nl: "\u0627\u0644\u0647\u0648\u0644\u0646\u062F\u064A\u0629",
    pl: "\u0627\u0644\u0628\u0648\u0644\u0646\u062F\u064A\u0629"
  },
  favouritesOnly: "\u0627\u0644\u0645\u0641\u0636\u0644\u0629",
  billedNote: "\u062A\u0634\u063A\u0651\u0644 \u0627\u0644\u0645\u0639\u0627\u064A\u0646\u0629 \u0639\u064A\u0646\u0629 \u0642\u0635\u064A\u0631\u0629 \u0648\u062A\u064F\u062D\u062A\u0633\u0628 \u062A\u0643\u0644\u0641\u062A\u0647\u0627 \u0639\u0644\u0649 \u062D\u0633\u0627\u0628\u0643 \u0641\u064A Fish Audio.",
  preview: "\u0645\u0639\u0627\u064A\u0646\u0629",
  stop: "\u0625\u064A\u0642\u0627\u0641",
  use: "\u0627\u0633\u062A\u062E\u062F\u0627\u0645",
  inUse: "\u0642\u064A\u062F \u0627\u0644\u0627\u0633\u062A\u062E\u062F\u0627\u0645",
  favourite: "\u0625\u0636\u0627\u0641\u0629 \u0625\u0644\u0649 \u0627\u0644\u0645\u0641\u0636\u0644\u0629",
  unfavourite: "\u0625\u0632\u0627\u0644\u0629 \u0645\u0646 \u0627\u0644\u0645\u0641\u0636\u0644\u0629",
  uses: (n) => `\u0645\u0631\u0627\u062A \u0627\u0644\u0627\u0633\u062A\u062E\u062F\u0627\u0645: ${compact5(n)}`,
  noVoices: "\u0644\u0627 \u062A\u0648\u062C\u062F \u0623\u0635\u0648\u0627\u062A \u0645\u0637\u0627\u0628\u0642\u0629",
  noFavourites: "\u0644\u0627 \u062A\u0648\u062C\u062F \u0623\u0635\u0648\u0627\u062A \u0645\u0641\u0636\u0644\u0629 \u0628\u0639\u062F",
  noFavouritesHint: "\u0636\u0639 \u0646\u062C\u0645\u0629 \u0639\u0644\u0649 \u0635\u0648\u062A \u0641\u064A \u0627\u0644\u0645\u0643\u062A\u0628\u0629 \u0644\u0644\u0627\u062D\u062A\u0641\u0627\u0638 \u0628\u0647 \u0647\u0646\u0627.",
  prev: "\u0627\u0644\u0633\u0627\u0628\u0642",
  next: "\u0627\u0644\u062A\u0627\u0644\u064A",
  pageOf: (page) => `\u0627\u0644\u0635\u0641\u062D\u0629 ${page}`,
  usedVoice: (title, profile) => `\u0623\u0635\u0628\u062D ${title} \u0627\u0644\u0622\u0646 \u0635\u0648\u062A ${agentName5(profile)}`,
  useOtherProvider: (provider) => `\u0645\u0632\u0648\u062F \u062A\u062D\u0648\u064A\u0644 \u0627\u0644\u0646\u0635 \u0625\u0644\u0649 \u0643\u0644\u0627\u0645 \u0627\u0644\u062D\u0627\u0644\u064A \u0647\u0648 ${provider}. \u0644\u0644\u062A\u0628\u062F\u064A\u0644 \u0627\u0633\u062A\u062E\u062F\u0645 \`hermes tools\` \u25B8 Text-to-Speech \u25B8 Fish Audio.`,
  useProviderByOperator: (provider) => `\u064A\u062D\u062F\u0651\u062F \u0645\u0634\u063A\u0651\u0644 \u0647\u0630\u0627 \u0627\u0644\u0648\u0643\u064A\u0644 \u0645\u0632\u0648\u062F \u062A\u062D\u0648\u064A\u0644 \u0627\u0644\u0646\u0635 \u0625\u0644\u0649 \u0643\u0644\u0627\u0645 (${provider}).`,
  loadFailed: "\u062A\u0639\u0630\u0631 \u062A\u062D\u0645\u064A\u0644 \u0627\u0644\u0623\u0635\u0648\u0627\u062A",
  retry: "\u0625\u0639\u0627\u062F\u0629 \u0627\u0644\u0645\u062D\u0627\u0648\u0644\u0629",
  mineEmpty: "\u0644\u0645 \u062A\u0646\u0634\u0626 \u0623\u064A \u0623\u0635\u0648\u0627\u062A \u0628\u0639\u062F",
  mineEmptyHint: "\u0627\u0633\u062A\u0646\u0633\u062E \u0635\u0648\u062A\u0643 \u0623\u0648 \u0635\u0645\u0651\u0645 \u0635\u0648\u062A\u064B\u0627 \u062C\u062F\u064A\u062F\u064B\u0627 \u0641\u064A \xAB\u0625\u0646\u0634\u0627\u0621\xBB.",
  delete: "\u062D\u0630\u0641",
  deleteTitle: (title) => `\u062D\u0630\u0641 \xAB${title}\xBB\u061F`,
  deleteBody: "\u0633\u064A\u0624\u062F\u064A \u0647\u0630\u0627 \u0625\u0644\u0649 \u0625\u0632\u0627\u0644\u0629 \u0627\u0644\u0635\u0648\u062A \u0645\u0646 \u062D\u0633\u0627\u0628\u0643 \u0641\u064A Fish Audio. \u0633\u064A\u062D\u062A\u0627\u062C \u0627\u0644\u0648\u0643\u0644\u0627\u0621 \u0627\u0644\u0630\u064A\u0646 \u064A\u0633\u062A\u062E\u062F\u0645\u0648\u0646 \u0647\u0630\u0627 \u0627\u0644\u0635\u0648\u062A \u0625\u0644\u0649 \u0627\u062E\u062A\u064A\u0627\u0631 \u0635\u0648\u062A \u0622\u062E\u0631 \u0644\u0647\u0645.",
  deleteConfirmLabel: (title) => `\u0627\u0643\u062A\u0628 \xAB${title}\xBB \u0644\u0644\u062A\u0623\u0643\u064A\u062F`,
  cancel: "\u0625\u0644\u063A\u0627\u0621",
  deleted: (title) => `\u062A\u0645 \u062D\u0630\u0641 ${title}`,
  cloneTitle: "\u0627\u0633\u062A\u0646\u0633\u0627\u062E \u0635\u0648\u062A",
  cloneBody: "\u0627\u0631\u0641\u0639 1\u20133 \u062A\u0633\u062C\u064A\u0644\u0627\u062A \u0648\u0627\u0636\u062D\u0629 \u0644\u0645\u062A\u062D\u062F\u062B \u0648\u0627\u062D\u062F (MP3 \u0623\u0648 WAV \u0623\u0648 OGG \u0623\u0648 WebM \u0623\u0648 FLAC \u0623\u0648 MP4\u060C \u0628\u062D\u062F \u0623\u0642\u0635\u0649 10 MB \u0644\u0643\u0644 \u0645\u0644\u0641).",
  chooseFiles: "\u0627\u062E\u062A\u064A\u0627\u0631 \u0645\u0644\u0641\u0627\u062A \u0635\u0648\u062A\u064A\u0629",
  voiceTitle: "\u0627\u0633\u0645 \u0627\u0644\u0635\u0648\u062A",
  descriptionOptional: "\u0627\u0644\u0648\u0635\u0641 (\u0627\u062E\u062A\u064A\u0627\u0631\u064A)",
  consent: "\u0644\u062F\u064A \u0625\u0630\u0646 \u0627\u0644\u0645\u062A\u062D\u062F\u062B \u0644\u0627\u0633\u062A\u0646\u0633\u0627\u062E \u0647\u0630\u0627 \u0627\u0644\u0635\u0648\u062A.",
  clone: "\u0627\u0633\u062A\u0646\u0633\u0627\u062E \u0627\u0644\u0635\u0648\u062A",
  cloneBilled: "\u062A\u064F\u062D\u062A\u0633\u0628 \u062A\u0643\u0644\u0641\u0629 \u0627\u0644\u0627\u0633\u062A\u0646\u0633\u0627\u062E \u0639\u0644\u0649 \u062D\u0633\u0627\u0628\u0643 \u0641\u064A Fish Audio.",
  uploading: (n, total, percent) => `\u062C\u0627\u0631\u064D \u0631\u0641\u0639 ${n} \u0645\u0646 ${total} \xB7 ${percent}%`,
  cloning: "\u062C\u0627\u0631\u064D \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u0635\u0648\u062A\u2026",
  cloned: (title) => `\u062A\u0645 \u0625\u0646\u0634\u0627\u0621 ${title}. \u0633\u062A\u062C\u062F\u0647 \u0641\u064A \xAB\u0623\u0635\u0648\u0627\u062A\u064A\xBB.`,
  operatorCloned: (title) => `\u062A\u0645 \u0625\u0646\u0634\u0627\u0621 ${title}. \u0633\u062A\u062C\u062F\u0647 \u0641\u064A \u0627\u0644\u0645\u0643\u062A\u0628\u0629 \u0636\u0645\u0646 \xAB\u0627\u0644\u0645\u0641\u0636\u0644\u0629\xBB.`,
  tooMany: "\u0627\u062E\u062A\u0631 \u0645\u0627 \u064A\u0635\u0644 \u0625\u0644\u0649 3 \u0645\u0644\u0641\u0627\u062A.",
  tooLarge: (name) => `\u062D\u062C\u0645 ${name} \u0623\u0643\u0628\u0631 \u0645\u0646 10 MB.`,
  agentChangedNothingSent: "\u062A\u063A\u064A\u0651\u0631 \u0627\u0644\u0648\u0643\u064A\u0644 \u0627\u0644\u0645\u062D\u062F\u062F\u060C \u0644\u0630\u0627 \u0644\u0645 \u064A\u062A\u0645 \u0625\u0631\u0633\u0627\u0644 \u0623\u064A \u0634\u064A\u0621.",
  agentChanged: "\u062A\u063A\u064A\u0651\u0631 \u0627\u0644\u0648\u0643\u064A\u0644 \u0627\u0644\u0645\u062D\u062F\u062F\u060C \u0644\u0630\u0627 \u062A\u0648\u0642\u0641 \u0627\u0644\u0631\u0641\u0639. \u0644\u0645 \u064A\u062A\u0645 \u0625\u0631\u0633\u0627\u0644 \u0623\u064A \u0634\u064A\u0621 \u0625\u0644\u0649 \u0627\u0644\u0648\u0643\u064A\u0644 \u0627\u0644\u0622\u062E\u0631.",
  designTitle: "\u062A\u0635\u0645\u064A\u0645 \u0635\u0648\u062A",
  designBody: "\u0635\u0650\u0641 \u0627\u0644\u0635\u0648\u062A \u0627\u0644\u0630\u064A \u062A\u0631\u064A\u062F\u0647. \u064A\u0646\u0634\u0626 Fish Audio \u0628\u0636\u0639\u0629 \u0623\u0635\u0648\u0627\u062A \u0645\u0631\u0634\u062D\u0629 \u0644\u062A\u062E\u062A\u0627\u0631 \u0645\u0646\u0647\u0627.",
  designPlaceholder: "\u0631\u0627\u0648\u064A\u0629 \u0628\u0631\u064A\u0637\u0627\u0646\u064A\u0629 \u0641\u064A \u0627\u0644\u0623\u0631\u0628\u0639\u064A\u0646\u064A\u0627\u062A\u060C \u0628\u0635\u0648\u062A \u062F\u0627\u0641\u0626 \u0648\u0647\u0627\u062F\u0626 \u0648\u0628\u062D\u0651\u0629 \u062E\u0641\u064A\u0641\u0629",
  design: "\u062A\u0635\u0645\u064A\u0645 \u0623\u0635\u0648\u0627\u062A",
  designing: "\u062C\u0627\u0631\u064D \u0627\u0644\u062A\u0635\u0645\u064A\u0645\u2026",
  designBilled: "\u062A\u064F\u062D\u062A\u0633\u0628 \u062A\u0643\u0644\u0641\u0629 \u0643\u0644 \u062A\u0635\u0645\u064A\u0645 \u0639\u0644\u0649 \u062D\u0633\u0627\u0628\u0643 \u0641\u064A Fish Audio.",
  candidate: (n) => `\u0627\u0644\u0635\u0648\u062A \u0627\u0644\u0645\u0631\u0634\u062D ${n}`,
  saveAs: "\u0627\u0644\u0627\u0633\u0645",
  save: "\u062D\u0641\u0638 \u0627\u0644\u0635\u0648\u062A",
  saved: (title) => `\u062A\u0645 \u062D\u0641\u0638 ${title}. \u0633\u062A\u062C\u062F\u0647 \u0641\u064A \xAB\u0623\u0635\u0648\u0627\u062A\u064A\xBB.`,
  operatorSaved: (title) => `\u062A\u0645 \u062D\u0641\u0638 ${title}. \u0633\u062A\u062C\u062F\u0647 \u0641\u064A \u0627\u0644\u0645\u0643\u062A\u0628\u0629 \u0636\u0645\u0646 \xAB\u0627\u0644\u0645\u0641\u0636\u0644\u0629\xBB.`,
  apiCredit: "\u0631\u0635\u064A\u062F API",
  lowCredit: "\u0627\u0644\u0631\u0635\u064A\u062F \u0645\u0646\u062E\u0641\u0636 \u2014 \u0627\u0634\u062D\u0646\u0647 \u0644\u062A\u0633\u062A\u0645\u0631 \u0627\u0644\u0631\u062F\u0648\u062F \u0627\u0644\u0635\u0648\u062A\u064A\u0629 \u0641\u064A \u0627\u0644\u0639\u0645\u0644.",
  topUps: "\u0625\u062C\u0645\u0627\u0644\u064A \u0627\u0644\u0634\u062D\u0646\u0627\u062A \u0645\u0646\u0630 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062D\u0633\u0627\u0628",
  freeCredit: "\u0627\u0644\u0631\u0635\u064A\u062F \u0627\u0644\u0645\u062C\u0627\u0646\u064A \u0627\u0644\u0645\u062A\u0627\u062D",
  plan: "\u0627\u0644\u062E\u0637\u0629",
  planBalance: (balance, total) => `\u062A\u0628\u0642\u0651\u0649 ${balance.toLocaleString("ar")} \u0645\u0646 ${total.toLocaleString("ar")} \u0648\u062D\u062F\u0629 \u0631\u0635\u064A\u062F`,
  renews: (date) => `\u062A\u062A\u062C\u062F\u062F \u0641\u064A ${date}`,
  periodEnds: (date) => `\u062A\u0646\u062A\u0647\u064A \u0627\u0644\u0641\u062A\u0631\u0629 \u0627\u0644\u062D\u0627\u0644\u064A\u0629 \u0641\u064A ${date}`,
  noPlan: "\u0644\u0627 \u062A\u0648\u062C\u062F \u062E\u0637\u0629 \u0644\u0644\u062A\u0637\u0628\u064A\u0642",
  planUnavailable: "\u062A\u0641\u0627\u0635\u064A\u0644 \u0627\u0644\u062E\u0637\u0629 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629 \u062D\u0627\u0644\u064A\u064B\u0627.",
  creditsSeparate: "\u0631\u0635\u064A\u062F \u062E\u0637\u0629 \u0627\u0644\u062A\u0637\u0628\u064A\u0642 \u0648\u0631\u0635\u064A\u062F API \u0645\u0646\u0641\u0635\u0644\u0627\u0646. \u062A\u0633\u062A\u062E\u062F\u0645 \u0627\u0644\u0631\u062F\u0648\u062F \u0627\u0644\u0635\u0648\u062A\u064A\u0629 \u0631\u0635\u064A\u062F API.",
  topUp: "\u0634\u062D\u0646 \u0631\u0635\u064A\u062F API",
  plans: "\u0627\u0644\u062E\u0637\u0637",
  apiKeys: "\u0645\u0641\u0627\u062A\u064A\u062D API",
  chip: (credit) => `Fish ${credit}`,
  chipTip: "\u0631\u0635\u064A\u062F API \u0644\u0640 Fish Audio",
  usd: (value) => `$${Number(value).toFixed(2)}`
};
function compact5(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

// src/desktop/locales/ru.ts
var agentName6 = (profile) => profile && profile !== "default" ? profile : ru.thisAgent;
var ru = {
  thisAgent: "\u044D\u0442\u043E\u0433\u043E \u0430\u0433\u0435\u043D\u0442\u0430",
  title: "\u0413\u043E\u043B\u043E\u0441\u0430",
  navLabel: "\u0413\u043E\u043B\u043E\u0441\u0430",
  paletteVoices: "Fish Audio: \u0413\u043E\u043B\u043E\u0441\u0430",
  paletteAccount: "Fish Audio: \u0410\u043A\u043A\u0430\u0443\u043D\u0442",
  poweredBy: "Fish Audio",
  forAgent: (profile) => `\u0414\u043B\u044F ${agentName6(profile)}`,
  notSetUp: (profile) => `Fish Audio \u0435\u0449\u0451 \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D \u043D\u0430 \u043A\u043E\u043C\u043F\u044C\u044E\u0442\u0435\u0440\u0435 ${agentName6(profile)}. \u0423\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u0435 \u0442\u0430\u043C \u043F\u043B\u0430\u0433\u0438\u043D, \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0435\u0433\u043E \u0438 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0448\u043B\u044E\u0437.`,
  tabs: { library: "\u0411\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0430", mine: "\u041C\u043E\u0438 \u0433\u043E\u043B\u043E\u0441\u0430", create: "\u0421\u043E\u0437\u0434\u0430\u0442\u044C", account: "\u0410\u043A\u043A\u0430\u0443\u043D\u0442" },
  operatorOnboardTitle: "\u0413\u043E\u043B\u043E\u0441 \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u0430\u0433\u0435\u043D\u0442\u0430 \u0435\u0449\u0451 \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D",
  operatorOnboardBody: "\u041F\u043E\u043F\u0440\u043E\u0441\u0438\u0442\u0435 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430 \u044D\u0442\u043E\u0433\u043E \u0430\u0433\u0435\u043D\u0442\u0430 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0443 Fish Audio.",
  operatorBilledNote: "\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440 \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u043E\u0434\u0438\u0442 \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 \u043E\u0431\u0440\u0430\u0437\u0435\u0446.",
  operatorCloneBilled: "\u041A\u043B\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0441\u043E\u0437\u0434\u0430\u0451\u0442 \u043D\u043E\u0432\u044B\u0439 \u0433\u043E\u043B\u043E\u0441 \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u0430\u0433\u0435\u043D\u0442\u0430.",
  operatorDesignBilled: "\u041A\u0430\u0436\u0434\u043E\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0435\u0442 \u043D\u043E\u0432\u044B\u0435 \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u044B \u0433\u043E\u043B\u043E\u0441\u043E\u0432.",
  onboardTitle: "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0430\u043A\u043A\u0430\u0443\u043D\u0442 Fish Audio",
  onboardBody: (profile) => `\u0414\u043B\u044F \u0433\u043E\u043B\u043E\u0441\u043E\u0432 \u043D\u0443\u0436\u0435\u043D API-\u043A\u043B\u044E\u0447 Fish Audio, \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u044B\u0439 \u0434\u043B\u044F ${agentName6(profile)}. \u041D\u043E\u0432\u044B\u0435 \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u044B \u043C\u043E\u0433\u0443\u0442 \u043D\u0430\u0447\u0430\u0442\u044C \u0441 \u0431\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u043E\u0439 \u043C\u043E\u0434\u0435\u043B\u0438 s2.1-pro-free.`,
  onboardStep1: "\u0421\u043E\u0437\u0434\u0430\u0439\u0442\u0435 \u0431\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u044B\u0439 API-\u043A\u043B\u044E\u0447 \u043D\u0430 fish.audio",
  onboardStep2: "\u0412\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u0435\u0433\u043E \u0432 \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u25B8 \u041F\u043B\u0430\u0433\u0438\u043D\u044B \u25B8 Fish Audio (\u0432 \u0431\u043E\u043B\u0435\u0435 \u0440\u0430\u043D\u043D\u0438\u0445 \u0432\u0435\u0440\u0441\u0438\u044F\u0445: \u0412\u043E\u0437\u043C\u043E\u0436\u043D\u043E\u0441\u0442\u0438 \u25B8 \u041F\u043B\u0430\u0433\u0438\u043D\u044B), \u0437\u0430\u0442\u0435\u043C \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0448\u043B\u044E\u0437",
  getKey: "\u041F\u043E\u043B\u0443\u0447\u0438\u0442\u044C API-\u043A\u043B\u044E\u0447",
  openPlugins: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043F\u043B\u0430\u0433\u0438\u043D\u044B",
  checkAgain: "\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u0435\u0449\u0451 \u0440\u0430\u0437",
  unreachable: (profile) => `\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C\u0441\u044F \u043A Fish Audio \u0434\u043B\u044F ${agentName6(profile)}`,
  search: "\u041F\u043E\u0438\u0441\u043A \u0433\u043E\u043B\u043E\u0441\u043E\u0432",
  language: "\u042F\u0437\u044B\u043A",
  anyLanguage: "\u041B\u044E\u0431\u043E\u0439 \u044F\u0437\u044B\u043A",
  languages: {
    en: "\u0410\u043D\u0433\u043B\u0438\u0439\u0441\u043A\u0438\u0439",
    zh: "\u041A\u0438\u0442\u0430\u0439\u0441\u043A\u0438\u0439",
    ja: "\u042F\u043F\u043E\u043D\u0441\u043A\u0438\u0439",
    ko: "\u041A\u043E\u0440\u0435\u0439\u0441\u043A\u0438\u0439",
    es: "\u0418\u0441\u043F\u0430\u043D\u0441\u043A\u0438\u0439",
    fr: "\u0424\u0440\u0430\u043D\u0446\u0443\u0437\u0441\u043A\u0438\u0439",
    de: "\u041D\u0435\u043C\u0435\u0446\u043A\u0438\u0439",
    it: "\u0418\u0442\u0430\u043B\u044C\u044F\u043D\u0441\u043A\u0438\u0439",
    pt: "\u041F\u043E\u0440\u0442\u0443\u0433\u0430\u043B\u044C\u0441\u043A\u0438\u0439",
    ru: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439",
    ar: "\u0410\u0440\u0430\u0431\u0441\u043A\u0438\u0439",
    nl: "\u041D\u0438\u0434\u0435\u0440\u043B\u0430\u043D\u0434\u0441\u043A\u0438\u0439",
    pl: "\u041F\u043E\u043B\u044C\u0441\u043A\u0438\u0439"
  },
  favouritesOnly: "\u0418\u0437\u0431\u0440\u0430\u043D\u043D\u043E\u0435",
  billedNote: "\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440 \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u043E\u0434\u0438\u0442 \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 \u043E\u0431\u0440\u0430\u0437\u0435\u0446 \u0438 \u043E\u043F\u043B\u0430\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0441 \u0432\u0430\u0448\u0435\u0433\u043E \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430 Fish Audio.",
  preview: "\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440",
  stop: "\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C",
  use: "\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C",
  inUse: "\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F",
  favourite: "\u0412 \u0438\u0437\u0431\u0440\u0430\u043D\u043D\u043E\u0435",
  unfavourite: "\u0423\u0431\u0440\u0430\u0442\u044C \u0438\u0437 \u0438\u0437\u0431\u0440\u0430\u043D\u043D\u043E\u0433\u043E",
  uses: (n) => `\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u0438\u0439: ${compact6(n)}`,
  noVoices: "\u041F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0438\u0445 \u0433\u043E\u043B\u043E\u0441\u043E\u0432 \u043D\u0435\u0442",
  noFavourites: "\u0418\u0437\u0431\u0440\u0430\u043D\u043D\u044B\u0445 \u0433\u043E\u043B\u043E\u0441\u043E\u0432 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442",
  noFavouritesHint: "\u041E\u0442\u043C\u0435\u0442\u044C\u0442\u0435 \u0433\u043E\u043B\u043E\u0441 \u0437\u0432\u0451\u0437\u0434\u043E\u0447\u043A\u043E\u0439 \u0432 \u0431\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0435, \u0447\u0442\u043E\u0431\u044B \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0435\u0433\u043E \u0437\u0434\u0435\u0441\u044C.",
  prev: "\u041D\u0430\u0437\u0430\u0434",
  next: "\u0414\u0430\u043B\u044C\u0448\u0435",
  pageOf: (page) => `\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 ${page}`,
  usedVoice: (title, profile) => `${title} \u0442\u0435\u043F\u0435\u0440\u044C \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u043A\u0430\u043A \u0433\u043E\u043B\u043E\u0441 ${agentName6(profile)}`,
  useOtherProvider: (provider) => `\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u0441\u0438\u043D\u0442\u0435\u0437\u0430 \u0440\u0435\u0447\u0438 \u2014 ${provider}. \u041F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u043C\u043E\u0436\u043D\u043E \u0432 \`hermes tools\` \u25B8 Text-to-Speech \u25B8 Fish Audio.`,
  useProviderByOperator: (provider) => `\u041F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u0441\u0438\u043D\u0442\u0435\u0437\u0430 \u0440\u0435\u0447\u0438 \u044D\u0442\u043E\u0433\u043E \u0430\u0433\u0435\u043D\u0442\u0430 (${provider}) \u0437\u0430\u0434\u0430\u043D \u0435\u0433\u043E \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C.`,
  loadFailed: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0433\u043E\u043B\u043E\u0441\u0430",
  retry: "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C",
  mineEmpty: "\u0412\u044B \u0435\u0449\u0451 \u043D\u0435 \u0441\u043E\u0437\u0434\u0430\u043B\u0438 \u043D\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u0433\u043E\u043B\u043E\u0441\u0430",
  mineEmptyHint: "\u041A\u043B\u043E\u043D\u0438\u0440\u0443\u0439\u0442\u0435 \u0441\u0432\u043E\u0439 \u0433\u043E\u043B\u043E\u0441 \u0438\u043B\u0438 \u0441\u043E\u0437\u0434\u0430\u0439\u0442\u0435 \u043D\u043E\u0432\u044B\u0439 \u043D\u0430 \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \xAB\u0421\u043E\u0437\u0434\u0430\u0442\u044C\xBB.",
  delete: "\u0423\u0434\u0430\u043B\u0438\u0442\u044C",
  deleteTitle: (title) => `\u0423\u0434\u0430\u043B\u0438\u0442\u044C \xAB${title}\xBB?`,
  deleteBody: "\u0413\u043E\u043B\u043E\u0441 \u0431\u0443\u0434\u0435\u0442 \u0443\u0434\u0430\u043B\u0451\u043D \u0438\u0437 \u0432\u0430\u0448\u0435\u0433\u043E \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430 Fish Audio. \u0414\u043B\u044F \u0430\u0433\u0435\u043D\u0442\u043E\u0432, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E\u0449\u0438\u0445 \u044D\u0442\u043E\u0442 \u0433\u043E\u043B\u043E\u0441, \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u0434\u0440\u0443\u0433\u043E\u0439.",
  deleteConfirmLabel: (title) => `\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \xAB${title}\xBB \u0434\u043B\u044F \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F`,
  cancel: "\u041E\u0442\u043C\u0435\u043D\u0430",
  deleted: (title) => `\u0413\u043E\u043B\u043E\u0441 ${title} \u0443\u0434\u0430\u043B\u0451\u043D`,
  cloneTitle: "\u041A\u043B\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0433\u043E\u043B\u043E\u0441",
  cloneBody: "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 1\u20133 \u0447\u0451\u0442\u043A\u0438\u0435 \u0437\u0430\u043F\u0438\u0441\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u0433\u043E\u0432\u043E\u0440\u044F\u0449\u0435\u0433\u043E (MP3, WAV, OGG, WebM, FLAC \u0438\u043B\u0438 MP4, \u0434\u043E 10 \u041C\u0411 \u043A\u0430\u0436\u0434\u0430\u044F).",
  chooseFiles: "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0430\u0443\u0434\u0438\u043E\u0444\u0430\u0439\u043B\u044B",
  voiceTitle: "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0433\u043E\u043B\u043E\u0441\u0430",
  descriptionOptional: "\u041E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 (\u043D\u0435\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u043E)",
  consent: "\u0423 \u043C\u0435\u043D\u044F \u0435\u0441\u0442\u044C \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u0433\u043E\u0432\u043E\u0440\u044F\u0449\u0435\u0433\u043E \u043D\u0430 \u043A\u043B\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u044D\u0442\u043E\u0433\u043E \u0433\u043E\u043B\u043E\u0441\u0430.",
  clone: "\u041A\u043B\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0433\u043E\u043B\u043E\u0441",
  cloneBilled: "\u041A\u043B\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u043E\u043F\u043B\u0430\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0441 \u0432\u0430\u0448\u0435\u0433\u043E \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430 Fish Audio.",
  uploading: (n, total, percent) => `\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 ${n} \u0438\u0437 ${total} \xB7 ${percent}%`,
  cloning: "\u0421\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0433\u043E\u043B\u043E\u0441\u0430\u2026",
  cloned: (title) => `\u0413\u043E\u043B\u043E\u0441 ${title} \u0441\u043E\u0437\u0434\u0430\u043D. \u041E\u043D \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0432 \u0440\u0430\u0437\u0434\u0435\u043B\u0435 \xAB\u041C\u043E\u0438 \u0433\u043E\u043B\u043E\u0441\u0430\xBB.`,
  operatorCloned: (title) => `\u0413\u043E\u043B\u043E\u0441 ${title} \u0441\u043E\u0437\u0434\u0430\u043D. \u041E\u043D \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0432 \u0431\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0435 \u0432 \u0440\u0430\u0437\u0434\u0435\u043B\u0435 \xAB\u0418\u0437\u0431\u0440\u0430\u043D\u043D\u043E\u0435\xBB.`,
  tooMany: "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u0435 \u0431\u043E\u043B\u0435\u0435 3 \u0444\u0430\u0439\u043B\u043E\u0432.",
  tooLarge: (name) => `${name} \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 10 \u041C\u0411.`,
  agentChangedNothingSent: "\u0412\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u0430\u0433\u0435\u043D\u0442 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0441\u044F, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u0431\u044B\u043B\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E.",
  agentChanged: "\u0412\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u0430\u0433\u0435\u043D\u0442 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0441\u044F, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430. \u0414\u0440\u0443\u0433\u043E\u043C\u0443 \u0430\u0433\u0435\u043D\u0442\u0443 \u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u0431\u044B\u043B\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E.",
  designTitle: "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0433\u043E\u043B\u043E\u0441 \u043F\u043E \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u044E",
  designBody: "\u041E\u043F\u0438\u0448\u0438\u0442\u0435 \u043D\u0443\u0436\u043D\u044B\u0439 \u0433\u043E\u043B\u043E\u0441. Fish Audio \u0441\u043E\u0437\u0434\u0430\u0441\u0442 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u043E\u0432 \u043D\u0430 \u0432\u044B\u0431\u043E\u0440.",
  designPlaceholder: "\u0411\u0440\u0438\u0442\u0430\u043D\u0441\u043A\u0430\u044F \u0440\u0430\u0441\u0441\u043A\u0430\u0437\u0447\u0438\u0446\u0430 \u0437\u0430 \u0441\u043E\u0440\u043E\u043A, \u0441 \u0442\u0451\u043F\u043B\u044B\u043C, \u043D\u0435\u0442\u043E\u0440\u043E\u043F\u043B\u0438\u0432\u044B\u043C, \u0441\u043B\u0435\u0433\u043A\u0430 \u0445\u0440\u0438\u043F\u043B\u043E\u0432\u0430\u0442\u044B\u043C \u0433\u043E\u043B\u043E\u0441\u043E\u043C",
  design: "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u044B",
  designing: "\u0421\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u043E\u0432\u2026",
  designBilled: "\u041A\u0430\u0436\u0434\u043E\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u043E\u0432 \u043E\u043F\u043B\u0430\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0441 \u0432\u0430\u0448\u0435\u0433\u043E \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430 Fish Audio.",
  candidate: (n) => `\u0412\u0430\u0440\u0438\u0430\u043D\u0442 ${n}`,
  saveAs: "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435",
  save: "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0433\u043E\u043B\u043E\u0441",
  saved: (title) => `\u0413\u043E\u043B\u043E\u0441 ${title} \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D. \u041E\u043D \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0432 \u0440\u0430\u0437\u0434\u0435\u043B\u0435 \xAB\u041C\u043E\u0438 \u0433\u043E\u043B\u043E\u0441\u0430\xBB.`,
  operatorSaved: (title) => `\u0413\u043E\u043B\u043E\u0441 ${title} \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D. \u041E\u043D \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0432 \u0431\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0435 \u0432 \u0440\u0430\u0437\u0434\u0435\u043B\u0435 \xAB\u0418\u0437\u0431\u0440\u0430\u043D\u043D\u043E\u0435\xBB.`,
  apiCredit: "\u0411\u0430\u043B\u0430\u043D\u0441 API",
  lowCredit: "\u041D\u0438\u0437\u043A\u0438\u0439 \u0431\u0430\u043B\u0430\u043D\u0441 \u2014 \u043F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u0435\u0433\u043E, \u0447\u0442\u043E\u0431\u044B \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u044B\u0435 \u043E\u0442\u0432\u0435\u0442\u044B \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u043B\u0438 \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C.",
  topUps: "\u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u0437\u0430 \u0432\u0441\u0451 \u0432\u0440\u0435\u043C\u044F",
  freeCredit: "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0439 \u0431\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u044B\u0439 \u0431\u0430\u043B\u0430\u043D\u0441",
  plan: "\u0422\u0430\u0440\u0438\u0444",
  planBalance: (balance, total) => `\u041E\u0441\u0442\u0430\u043B\u043E\u0441\u044C ${balance.toLocaleString("ru")} \u0438\u0437 ${total.toLocaleString("ru")} \u043A\u0440\u0435\u0434\u0438\u0442\u043E\u0432`,
  renews: (date) => `\u041F\u0440\u043E\u0434\u043B\u0435\u043D\u0438\u0435: ${date}`,
  periodEnds: (date) => `\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u043F\u0435\u0440\u0438\u043E\u0434 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044F ${date}`,
  noPlan: "\u041D\u0435\u0442 \u0442\u0430\u0440\u0438\u0444\u0430 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F",
  planUnavailable: "\u0418\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044F \u043E \u0442\u0430\u0440\u0438\u0444\u0435 \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430.",
  creditsSeparate: "\u041A\u0440\u0435\u0434\u0438\u0442\u044B \u0442\u0430\u0440\u0438\u0444\u0430 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0438 \u043A\u0440\u0435\u0434\u0438\u0442\u044B API \u0443\u0447\u0438\u0442\u044B\u0432\u0430\u044E\u0442\u0441\u044F \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E. \u0413\u043E\u043B\u043E\u0441\u043E\u0432\u044B\u0435 \u043E\u0442\u0432\u0435\u0442\u044B \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E\u0442 \u0431\u0430\u043B\u0430\u043D\u0441 API.",
  topUp: "\u041F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0431\u0430\u043B\u0430\u043D\u0441 API",
  plans: "\u0422\u0430\u0440\u0438\u0444\u044B",
  apiKeys: "API-\u043A\u043B\u044E\u0447\u0438",
  chip: (credit) => `Fish ${credit}`,
  chipTip: "\u0411\u0430\u043B\u0430\u043D\u0441 API Fish Audio",
  usd: (value) => `$${Number(value).toFixed(2)}`
};
function compact6(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

// src/desktop/locales/fr.ts
var agentName7 = (profile) => profile && profile !== "default" ? profile : fr.thisAgent;
var fr = {
  thisAgent: "cet agent",
  title: "Voix",
  navLabel: "Voix",
  paletteVoices: "Fish Audio : Voix",
  paletteAccount: "Fish Audio : Compte",
  poweredBy: "Fish Audio",
  forAgent: (profile) => `Pour ${agentName7(profile)}`,
  notSetUp: (profile) => `Fish Audio n\u2019est pas encore configur\xE9 sur la machine de ${agentName7(profile)}. Installez-y le plugin, activez-le et red\xE9marrez le gateway.`,
  tabs: { library: "Biblioth\xE8que", mine: "Mes voix", create: "Cr\xE9er", account: "Compte" },
  operatorOnboardTitle: "La voix n\u2019est pas encore configur\xE9e pour cet agent",
  operatorOnboardBody: "Demandez \xE0 l\u2019op\xE9rateur de cet agent de terminer la configuration de Fish Audio.",
  operatorBilledNote: "L\u2019aper\xE7u joue un court extrait.",
  operatorCloneBilled: "Le clonage cr\xE9e une nouvelle voix pour cet agent.",
  operatorDesignBilled: "Chaque conception cr\xE9e de nouvelles voix propos\xE9es.",
  onboardTitle: "Connectez votre compte Fish Audio",
  onboardBody: (profile) => `Les voix n\xE9cessitent une cl\xE9 API Fish Audio pour ${agentName7(profile)}. Les nouveaux comptes peuvent commencer avec le mod\xE8le gratuit s2.1-pro-free.`,
  onboardStep1: "Cr\xE9ez une cl\xE9 API gratuite sur fish.audio",
  onboardStep2: "Collez-la dans Param\xE8tres \u25B8 Plugins \u25B8 Fish Audio (dans les versions ant\xE9rieures : Capacit\xE9s \u25B8 Plugins), puis red\xE9marrez le gateway",
  getKey: "Obtenir une cl\xE9 API",
  openPlugins: "Ouvrir les plugins",
  checkAgain: "V\xE9rifier \xE0 nouveau",
  unreachable: (profile) => `Impossible de joindre Fish Audio sur ${agentName7(profile)}`,
  search: "Rechercher des voix",
  language: "Langue",
  anyLanguage: "Toutes les langues",
  languages: {
    en: "Anglais",
    zh: "Chinois",
    ja: "Japonais",
    ko: "Cor\xE9en",
    es: "Espagnol",
    fr: "Fran\xE7ais",
    de: "Allemand",
    it: "Italien",
    pt: "Portugais",
    ru: "Russe",
    ar: "Arabe",
    nl: "N\xE9erlandais",
    pl: "Polonais"
  },
  favouritesOnly: "Favoris",
  billedNote: "L\u2019aper\xE7u joue un court extrait et est factur\xE9 \xE0 votre compte Fish Audio.",
  preview: "\xC9couter",
  stop: "Arr\xEAter",
  use: "Utiliser",
  inUse: "Utilis\xE9e",
  favourite: "Ajouter aux favoris",
  unfavourite: "Retirer des favoris",
  uses: (n) => `${compact7(n)} ${n < 2 ? "utilisation" : "utilisations"}`,
  noVoices: "Aucune voix correspondante",
  noFavourites: "Aucun favori pour le moment",
  noFavouritesHint: "Ajoutez une voix aux favoris dans la biblioth\xE8que pour la retrouver ici.",
  prev: "Pr\xE9c\xE9dente",
  next: "Suivante",
  pageOf: (page) => `Page ${page}`,
  usedVoice: (title, profile) => `${title} est maintenant la voix de ${agentName7(profile)}`,
  useOtherProvider: (provider) => `Votre fournisseur de synth\xE8se vocale actuel est ${provider}. Changez-le dans \`hermes tools\` \u25B8 Text-to-Speech \u25B8 Fish Audio.`,
  useProviderByOperator: (provider) => `Le fournisseur de synth\xE8se vocale de cet agent (${provider}) est d\xE9fini par son op\xE9rateur.`,
  loadFailed: "Impossible de charger les voix",
  retry: "R\xE9essayer",
  mineEmpty: "Vous n\u2019avez pas encore cr\xE9\xE9 de voix",
  mineEmptyHint: "Clonez votre voix ou concevez-en une nouvelle dans Cr\xE9er.",
  delete: "Supprimer",
  deleteTitle: (title) => `Supprimer \xAB ${title} \xBB ?`,
  deleteBody: "Cette action supprime la voix de votre compte Fish Audio. Il faudra s\xE9lectionner une autre voix pour les agents qui l\u2019utilisent.",
  deleteConfirmLabel: (title) => `Saisissez \xAB ${title} \xBB pour confirmer`,
  cancel: "Annuler",
  deleted: (title) => `${title} supprim\xE9e`,
  cloneTitle: "Cloner une voix",
  cloneBody: "Importez 1 \xE0 3 enregistrements clairs d\u2019une seule personne (MP3, WAV, OGG, WebM, FLAC ou MP4, jusqu\u2019\xE0 10 Mo chacun).",
  chooseFiles: "Choisir des fichiers audio",
  voiceTitle: "Nom de la voix",
  descriptionOptional: "Description (facultative)",
  consent: "J\u2019ai l\u2019autorisation de la personne qui parle pour cloner cette voix.",
  clone: "Cloner la voix",
  cloneBilled: "Le clonage est factur\xE9 \xE0 votre compte Fish Audio.",
  uploading: (n, total, percent) => `Envoi de ${n} sur ${total} \xB7 ${percent} %`,
  cloning: "Cr\xE9ation de la voix\u2026",
  cloned: (title) => `${title} cr\xE9\xE9e. Retrouvez-la dans Mes voix.`,
  operatorCloned: (title) => `${title} cr\xE9\xE9e. Retrouvez-la dans la Biblioth\xE8que, sous Favoris.`,
  tooMany: "Choisissez jusqu\u2019\xE0 3 fichiers.",
  tooLarge: (name) => `${name} d\xE9passe 10 Mo.`,
  agentChangedNothingSent: "L\u2019agent s\xE9lectionn\xE9 a chang\xE9, donc rien n\u2019a \xE9t\xE9 envoy\xE9.",
  agentChanged: "L\u2019agent s\xE9lectionn\xE9 a chang\xE9, donc l\u2019envoi s\u2019est arr\xEAt\xE9. Rien n\u2019a \xE9t\xE9 envoy\xE9 \xE0 l\u2019autre agent.",
  designTitle: "Concevoir une voix",
  designBody: "D\xE9crivez la voix souhait\xE9e. Fish Audio cr\xE9e quelques propositions parmi lesquelles choisir.",
  designPlaceholder: "Une narratrice britannique d\u2019une quarantaine d\u2019ann\xE9es, \xE0 la voix chaleureuse, pos\xE9e et l\xE9g\xE8rement rauque",
  design: "Concevoir des voix",
  designing: "Conception\u2026",
  designBilled: "Chaque conception est factur\xE9e \xE0 votre compte Fish Audio.",
  candidate: (n) => `Proposition ${n}`,
  saveAs: "Nom",
  save: "Enregistrer la voix",
  saved: (title) => `${title} enregistr\xE9e. Retrouvez-la dans Mes voix.`,
  operatorSaved: (title) => `${title} enregistr\xE9e. Retrouvez-la dans la Biblioth\xE8que, sous Favoris.`,
  apiCredit: "Cr\xE9dit API",
  lowCredit: "Solde faible \u2014 rechargez pour continuer \xE0 recevoir des r\xE9ponses vocales.",
  topUps: "Recharges cumul\xE9es",
  freeCredit: "Cr\xE9dit gratuit disponible",
  plan: "Forfait",
  planBalance: (balance, total) => `${balance.toLocaleString("fr")} cr\xE9dits restants sur ${total.toLocaleString("fr")}`,
  renews: (date) => `Renouvellement le ${date}`,
  periodEnds: (date) => `La p\xE9riode actuelle se termine le ${date}`,
  noPlan: "Aucun forfait pour l\u2019application",
  planUnavailable: "Les d\xE9tails du forfait sont indisponibles pour le moment.",
  creditsSeparate: "Les cr\xE9dits du forfait de l\u2019application et les cr\xE9dits API sont distincts. Les r\xE9ponses vocales utilisent le cr\xE9dit API.",
  topUp: "Recharger le cr\xE9dit API",
  plans: "Forfaits",
  apiKeys: "Cl\xE9s API",
  chip: (credit) => `Fish ${credit}`,
  chipTip: "Cr\xE9dit API Fish Audio",
  usd: (value) => `$${Number(value).toFixed(2)}`
};
function compact7(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

// src/desktop/locales/de.ts
var agentName8 = (profile) => profile && profile !== "default" ? profile : de.thisAgent;
var de = {
  thisAgent: "diesen Agenten",
  title: "Stimmen",
  navLabel: "Stimmen",
  paletteVoices: "Fish Audio: Stimmen",
  paletteAccount: "Fish Audio: Konto",
  poweredBy: "Fish Audio",
  forAgent: (profile) => `F\xFCr ${agentName8(profile)}`,
  notSetUp: (profile) => `Fish Audio ist auf dem Computer f\xFCr ${agentName8(profile)} noch nicht eingerichtet. Installieren Sie dort das Plugin, aktivieren Sie es und starten Sie das Gateway neu.`,
  tabs: { library: "Bibliothek", mine: "Meine Stimmen", create: "Erstellen", account: "Konto" },
  operatorOnboardTitle: "Die Stimme ist f\xFCr diesen Agenten noch nicht eingerichtet",
  operatorOnboardBody: "Bitten Sie den Betreiber dieses Agenten, die Einrichtung von Fish Audio abzuschlie\xDFen.",
  operatorBilledNote: "Die Vorschau spielt eine kurze H\xF6rprobe ab.",
  operatorCloneBilled: "Beim Klonen entsteht eine neue Stimme f\xFCr diesen Agenten.",
  operatorDesignBilled: "Jeder Entwurf erstellt neue Stimmen zur Auswahl.",
  onboardTitle: "Verbinden Sie Ihr Fish Audio-Konto",
  onboardBody: (profile) => `F\xFCr ${agentName8(profile)} wird ein Fish Audio API-Schl\xFCssel ben\xF6tigt. Neue Konten k\xF6nnen mit dem kostenlosen Modell s2.1-pro-free beginnen.`,
  onboardStep1: "Erstellen Sie einen kostenlosen API-Schl\xFCssel auf fish.audio",
  onboardStep2: "F\xFCgen Sie ihn unter Einstellungen \u25B8 Plugins \u25B8 Fish Audio ein (in \xE4lteren Versionen: F\xE4higkeiten \u25B8 Plugins) und starten Sie dann das Gateway neu",
  getKey: "API-Schl\xFCssel erhalten",
  openPlugins: "Plugins \xF6ffnen",
  checkAgain: "Erneut pr\xFCfen",
  unreachable: (profile) => `Fish Audio f\xFCr ${agentName8(profile)} war nicht erreichbar`,
  search: "Stimmen suchen",
  language: "Sprache",
  anyLanguage: "Alle Sprachen",
  languages: {
    en: "Englisch",
    zh: "Chinesisch",
    ja: "Japanisch",
    ko: "Koreanisch",
    es: "Spanisch",
    fr: "Franz\xF6sisch",
    de: "Deutsch",
    it: "Italienisch",
    pt: "Portugiesisch",
    ru: "Russisch",
    ar: "Arabisch",
    nl: "Niederl\xE4ndisch",
    pl: "Polnisch"
  },
  favouritesOnly: "Favoriten",
  billedNote: "Die Vorschau spielt eine kurze H\xF6rprobe ab und wird Ihrem Fish Audio-Konto berechnet.",
  preview: "Vorschau",
  stop: "Stoppen",
  use: "Verwenden",
  inUse: "In Verwendung",
  favourite: "Als Favorit markieren",
  unfavourite: "Favorit entfernen",
  uses: (n) => `${compact8(n)} ${n === 1 ? "Nutzung" : "Nutzungen"}`,
  noVoices: "Keine passenden Stimmen",
  noFavourites: "Noch keine Favoriten",
  noFavouritesHint: "Markieren Sie eine Stimme in der Bibliothek mit einem Stern, um sie hier zu speichern.",
  prev: "Zur\xFCck",
  next: "Weiter",
  pageOf: (page) => `Seite ${page}`,
  usedVoice: (title, profile) => `${title} ist jetzt die Stimme f\xFCr ${agentName8(profile)}`,
  useOtherProvider: (provider) => `Ihr aktueller Text-zu-Sprache-Anbieter ist ${provider}. Wechseln Sie mit \`hermes tools\` \u25B8 Text-to-Speech \u25B8 Fish Audio.`,
  useProviderByOperator: (provider) => `Der Text-zu-Sprache-Anbieter dieses Agenten (${provider}) wird von seinem Betreiber festgelegt.`,
  loadFailed: "Stimmen konnten nicht geladen werden",
  retry: "Erneut versuchen",
  mineEmpty: "Sie haben noch keine Stimmen erstellt",
  mineEmptyHint: "Klonen Sie Ihre Stimme oder entwerfen Sie unter Erstellen eine neue.",
  delete: "L\xF6schen",
  deleteTitle: (title) => `\u201E${title}\u201C l\xF6schen?`,
  deleteBody: "Dadurch wird die Stimme aus Ihrem Fish Audio-Konto entfernt. F\xFCr Agenten, die diese Stimme verwenden, muss eine andere Stimme ausgew\xE4hlt werden.",
  deleteConfirmLabel: (title) => `Geben Sie zur Best\xE4tigung \u201E${title}\u201C ein`,
  cancel: "Abbrechen",
  deleted: (title) => `${title} gel\xF6scht`,
  cloneTitle: "Stimme klonen",
  cloneBody: "Laden Sie 1\u20133 klare Aufnahmen einer einzelnen sprechenden Person hoch (MP3, WAV, OGG, WebM, FLAC oder MP4, jeweils bis zu 10 MB).",
  chooseFiles: "Audiodateien ausw\xE4hlen",
  voiceTitle: "Name der Stimme",
  descriptionOptional: "Beschreibung (optional)",
  consent: "Ich habe die Erlaubnis der sprechenden Person, diese Stimme zu klonen.",
  clone: "Stimme klonen",
  cloneBilled: "Das Klonen wird Ihrem Fish Audio-Konto berechnet.",
  uploading: (n, total, percent) => `Hochladen: ${n} von ${total} \xB7 ${percent} %`,
  cloning: "Stimme wird erstellt\u2026",
  cloned: (title) => `${title} erstellt. Sie finden die Stimme unter Meine Stimmen.`,
  operatorCloned: (title) => `${title} erstellt. Sie finden die Stimme in der Bibliothek unter Favoriten.`,
  tooMany: "W\xE4hlen Sie bis zu 3 Dateien aus.",
  tooLarge: (name) => `${name} ist gr\xF6\xDFer als 10 MB.`,
  agentChangedNothingSent: "Der ausgew\xE4hlte Agent hat sich ge\xE4ndert. Deshalb wurde nichts gesendet.",
  agentChanged: "Der ausgew\xE4hlte Agent hat sich ge\xE4ndert. Deshalb wurde das Hochladen gestoppt. Es wurde nichts an den anderen Agenten gesendet.",
  designTitle: "Stimme entwerfen",
  designBody: "Beschreiben Sie die gew\xFCnschte Stimme. Fish Audio erstellt einige Vorschl\xE4ge zur Auswahl.",
  designPlaceholder: "Eine britische Erz\xE4hlerin in den Vierzigern mit warmer, ruhiger und leicht rauer Stimme",
  design: "Stimmen entwerfen",
  designing: "Stimmen werden entworfen\u2026",
  designBilled: "Jeder Entwurf wird Ihrem Fish Audio-Konto berechnet.",
  candidate: (n) => `Vorschlag ${n}`,
  saveAs: "Name",
  save: "Stimme speichern",
  saved: (title) => `${title} gespeichert. Sie finden die Stimme unter Meine Stimmen.`,
  operatorSaved: (title) => `${title} gespeichert. Sie finden die Stimme in der Bibliothek unter Favoriten.`,
  apiCredit: "API-Guthaben",
  lowCredit: "Guthaben niedrig \u2014 laden Sie es auf, damit Sprachantworten weiter funktionieren.",
  topUps: "Aufladungen insgesamt",
  freeCredit: "Kostenloses Guthaben verf\xFCgbar",
  plan: "Tarif",
  planBalance: (balance, total) => `${balance.toLocaleString("de")} von ${total.toLocaleString("de")} Credits \xFCbrig`,
  renews: (date) => `Verl\xE4ngert sich am ${date}`,
  periodEnds: (date) => `Der aktuelle Zeitraum endet am ${date}`,
  noPlan: "Kein App-Tarif",
  planUnavailable: "Tarifdetails sind derzeit nicht verf\xFCgbar.",
  creditsSeparate: "App-Tarif-Credits und API-Guthaben sind getrennt. Sprachantworten verwenden API-Guthaben.",
  topUp: "API-Guthaben aufladen",
  plans: "Tarife",
  apiKeys: "API-Schl\xFCssel",
  chip: (credit) => `Fish ${credit}`,
  chipTip: "Fish Audio API-Guthaben",
  usd: (value) => `$${Number(value).toFixed(2)}`
};
function compact8(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

// src/desktop/locales/es.ts
var agentName9 = (profile) => profile && profile !== "default" ? profile : es.thisAgent;
var es = {
  thisAgent: "este agente",
  title: "Voces",
  navLabel: "Voces",
  paletteVoices: "Fish Audio: Voces",
  paletteAccount: "Fish Audio: Cuenta",
  poweredBy: "Fish Audio",
  forAgent: (profile) => `Para ${agentName9(profile)}`,
  notSetUp: (profile) => `Fish Audio a\xFAn no est\xE1 configurado en el equipo de ${agentName9(profile)}. Instala all\xED el plugin, act\xEDvalo y reinicia el gateway.`,
  tabs: { library: "Biblioteca", mine: "Mis voces", create: "Crear", account: "Cuenta" },
  operatorOnboardTitle: "La voz a\xFAn no est\xE1 configurada para este agente",
  operatorOnboardBody: "Pide al operador de este agente que termine de configurar Fish Audio.",
  operatorBilledNote: "La vista previa reproduce una muestra breve.",
  operatorCloneBilled: "La clonaci\xF3n crea una voz nueva para este agente.",
  operatorDesignBilled: "Cada dise\xF1o crea nuevas voces candidatas.",
  onboardTitle: "Conecta tu cuenta de Fish Audio",
  onboardBody: (profile) => `Las voces necesitan una clave API de Fish Audio en ${agentName9(profile)}. Las cuentas nuevas pueden empezar con el modelo gratuito s2.1-pro-free.`,
  onboardStep1: "Crea una clave API gratuita en fish.audio",
  onboardStep2: "P\xE9gala en Configuraci\xF3n \u25B8 Plugins \u25B8 Fish Audio (en versiones anteriores: Capacidades \u25B8 Plugins) y reinicia el gateway",
  getKey: "Obtener una clave API",
  openPlugins: "Abrir Plugins",
  checkAgain: "Volver a comprobar",
  unreachable: (profile) => `No se pudo acceder a Fish Audio en ${agentName9(profile)}`,
  search: "Buscar voces",
  language: "Idioma",
  anyLanguage: "Todos los idiomas",
  languages: {
    en: "Ingl\xE9s",
    zh: "Chino",
    ja: "Japon\xE9s",
    ko: "Coreano",
    es: "Espa\xF1ol",
    fr: "Franc\xE9s",
    de: "Alem\xE1n",
    it: "Italiano",
    pt: "Portugu\xE9s",
    ru: "Ruso",
    ar: "\xC1rabe",
    nl: "Neerland\xE9s",
    pl: "Polaco"
  },
  favouritesOnly: "Favoritos",
  billedNote: "La vista previa reproduce una muestra breve y se factura a tu cuenta de Fish Audio.",
  preview: "Vista previa",
  stop: "Detener",
  use: "Usar",
  inUse: "En uso",
  favourite: "A\xF1adir a favoritos",
  unfavourite: "Quitar de favoritos",
  uses: (n) => `${compact9(n)} ${n === 1 ? "uso" : "usos"}`,
  noVoices: "No hay voces que coincidan",
  noFavourites: "A\xFAn no hay favoritos",
  noFavouritesHint: "Marca una voz con una estrella en la biblioteca para guardarla aqu\xED.",
  prev: "Anterior",
  next: "Siguiente",
  pageOf: (page) => `P\xE1gina ${page}`,
  usedVoice: (title, profile) => `${title} es ahora la voz de ${agentName9(profile)}`,
  useOtherProvider: (provider) => `Tu proveedor de texto a voz actual es ${provider}. C\xE1mbialo con \`hermes tools\` \u25B8 Text-to-Speech \u25B8 Fish Audio.`,
  useProviderByOperator: (provider) => `El proveedor de texto a voz de este agente (${provider}) lo establece su operador.`,
  loadFailed: "No se pudieron cargar las voces",
  retry: "Reintentar",
  mineEmpty: "A\xFAn no has creado ninguna voz",
  mineEmptyHint: "Clona tu voz o dise\xF1a una nueva en Crear.",
  delete: "Eliminar",
  deleteTitle: (title) => `\xBFEliminar \xAB${title}\xBB?`,
  deleteBody: "Esto elimina la voz de tu cuenta de Fish Audio. Habr\xE1 que seleccionar otra voz para los agentes que la usan.",
  deleteConfirmLabel: (title) => `Escribe \xAB${title}\xBB para confirmar`,
  cancel: "Cancelar",
  deleted: (title) => `${title} eliminada`,
  cloneTitle: "Clonar una voz",
  cloneBody: "Sube entre 1 y 3 grabaciones claras de una sola persona (MP3, WAV, OGG, WebM, FLAC o MP4, de hasta 10 MB cada una).",
  chooseFiles: "Elegir archivos de audio",
  voiceTitle: "Nombre de la voz",
  descriptionOptional: "Descripci\xF3n (opcional)",
  consent: "Tengo permiso de la persona que habla para clonar esta voz.",
  clone: "Clonar voz",
  cloneBilled: "La clonaci\xF3n se factura a tu cuenta de Fish Audio.",
  uploading: (n, total, percent) => `Subiendo ${n} de ${total} \xB7 ${percent} %`,
  cloning: "Creando la voz\u2026",
  cloned: (title) => `${title} creada. La encontrar\xE1s en Mis voces.`,
  operatorCloned: (title) => `${title} creada. La encontrar\xE1s en la Biblioteca, en Favoritos.`,
  tooMany: "Elige hasta 3 archivos.",
  tooLarge: (name) => `${name} supera los 10 MB.`,
  agentChangedNothingSent: "El agente seleccionado cambi\xF3, as\xED que no se envi\xF3 nada.",
  agentChanged: "El agente seleccionado cambi\xF3, as\xED que la subida se detuvo. No se envi\xF3 nada al otro agente.",
  designTitle: "Dise\xF1ar una voz",
  designBody: "Describe la voz que quieres. Fish Audio crea varias candidatas para que elijas.",
  designPlaceholder: "Una narradora brit\xE1nica de unos cuarenta a\xF1os, con voz c\xE1lida, pausada y ligeramente ronca",
  design: "Dise\xF1ar voces",
  designing: "Dise\xF1ando\u2026",
  designBilled: "Cada dise\xF1o se factura a tu cuenta de Fish Audio.",
  candidate: (n) => `Candidata ${n}`,
  saveAs: "Nombre",
  save: "Guardar voz",
  saved: (title) => `${title} guardada. La encontrar\xE1s en Mis voces.`,
  operatorSaved: (title) => `${title} guardada. La encontrar\xE1s en la Biblioteca, en Favoritos.`,
  apiCredit: "Cr\xE9dito API",
  lowCredit: "Saldo bajo \u2014 recarga para que las respuestas de voz sigan funcionando.",
  topUps: "Recargas acumuladas",
  freeCredit: "Cr\xE9dito gratuito disponible",
  plan: "Plan",
  planBalance: (balance, total) => `Quedan ${balance.toLocaleString("es")} de ${total.toLocaleString("es")} cr\xE9ditos`,
  renews: (date) => `Se renueva el ${date}`,
  periodEnds: (date) => `El periodo actual termina el ${date}`,
  noPlan: "Sin plan de la app",
  planUnavailable: "Los detalles del plan no est\xE1n disponibles ahora mismo.",
  creditsSeparate: "Los cr\xE9ditos del plan de la app y los cr\xE9ditos API son independientes. Las respuestas de voz usan cr\xE9dito API.",
  topUp: "Recargar cr\xE9dito API",
  plans: "Planes",
  apiKeys: "Claves API",
  chip: (credit) => `Fish ${credit}`,
  chipTip: "Cr\xE9dito API de Fish Audio",
  usd: (value) => `$${Number(value).toFixed(2)}`
};
function compact9(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

// src/desktop/plugin.tsx
import { jsx as jsx4 } from "react/jsx-runtime";
var PROBE_INTERVAL_MS = 6e4;
var ACCOUNT_REFRESH_MS = 5 * 6e4;
function openTab(tab) {
  $tab.set(tab);
  host4.navigate(PAGE_PATH);
}
function CreditChip() {
  const t = usePluginI18n5(PLUGIN_ID);
  const account = useValue4($account);
  if (!account) return null;
  return /* @__PURE__ */ jsx4(
    "button",
    {
      "aria-label": t("chipTip"),
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
      title: account.low ? t("lowCredit") : t("chipTip"),
      type: "button",
      children: t("chip", t("usd", account.credit))
    }
  );
}
function registerAvailabilityGate(ctx) {
  let removers = null;
  let accountRemovers = null;
  let retries = 0;
  let cancelRetry;
  let disposed = false;
  let generation = 0;
  let accountAt = 0;
  let forcePending = false;
  $available.set(null);
  $account.set(null);
  $availableError.set(null);
  const show = (available, account = false) => {
    if (disposed) return;
    if (available && !removers) {
      removers = [
        ctx.register({
          id: "nav",
          area: SIDEBAR_NAV_AREA,
          order: 46,
          data: { codicon: "unmute", label: ctx.i18n.t("navLabel"), path: PAGE_PATH }
        }),
        ctx.register({
          id: "palette-voices",
          area: PALETTE_AREA,
          data: { id: "fish-audio.voices", keywords: ["fish", "voice", "tts"], label: ctx.i18n.t("paletteVoices"), run: () => openTab("library") }
        })
      ];
    } else if (!available && removers) {
      removers.forEach((remove) => remove());
      removers = null;
    }
    if (available && account && !accountRemovers) {
      accountRemovers = [
        ctx.register({ id: "credit", area: STATUSBAR_AREAS.right, order: 70, render: () => /* @__PURE__ */ jsx4(CreditChip, {}) }),
        ctx.register({
          id: "palette-account",
          area: PALETTE_AREA,
          data: { id: "fish-audio.account", keywords: ["fish", "credit", "balance"], label: ctx.i18n.t("paletteAccount"), run: () => openTab("account") }
        })
      ];
    } else if ((!available || !account) && accountRemovers) {
      accountRemovers.forEach((remove) => remove());
      accountRemovers = null;
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
        cancelRetry?.();
        $availableError.set(null);
        $available.set({ key: res?.key === true, version: String(res?.version ?? ""), account: res?.account !== false });
        show(true, res?.account !== false);
        if (res?.key !== true || res?.account === false) {
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
          if ($available.get() === null) {
            $availableError.set(error);
            if (!cancelRetry && retries < 3) {
              const epoch2 = currentAgentEpoch();
              cancelRetry = ctx.setTimeout(() => {
                if (disposed || epoch2 !== currentAgentEpoch()) return;
                cancelRetry = void 0;
                if ($available.get() === null) void probe();
              }, [5e3, 15e3, 3e4][retries++]);
            }
          }
          return;
        }
        cancelRetry?.();
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
    cancelRetry?.();
    cancelRetry = void 0;
    retries = 0;
    $account.set(null);
    $available.set(null);
    show(false);
    void probe(true);
  };
  const stops = [host4.state.profile.listen(onAgentChange), host4.state.connectionId.listen(onAgentChange), ctx.i18n.onLocaleChange(() => {
    if (disposed || !removers) return;
    const accountShown = accountRemovers !== null;
    show(false);
    show(true, accountShown);
  })];
  ctx.onDispose(() => {
    disposed = true;
    cancelRetry?.();
    stops.forEach((stop2) => stop2());
  });
  return { probe };
}
var plugin = {
  id: PLUGIN_ID,
  name: "Fish Audio",
  description: "A Voices page for Fish Audio: search and preview the voice library, use a voice, clone or design voices, and see your account.",
  register(ctx) {
    ctx.i18n.register({ en, zh, "zh-hant": zhHant, ja, ar, ru, fr, de, es });
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
