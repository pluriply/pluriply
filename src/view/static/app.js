// Pluriply 화면(B 배치) — 읽기 전용. AI 가 쓴 글은 textContent·createElement·renderMarkdown 으로만 넣는다.
import { parseMarkdown, renderMarkdown } from "/markdown.js";
import { makeReconnect } from "/reconnect.js";

const T = {
  en: {
    channels: "Channels",
    search: "Search requests, results, notes",
    people: "Participants",
    tasks: "Tasks",
    notes: "Shared notes",
    request: "Request",
    result: "Result",
    attachments: "Attachments",
    flow: "Flow",
    worker: "(worker)",
    review: "review",
    sent: "sent",
    working: "in progress",
    status: {
      submitted: "sent",
      working: "in progress",
      completed: "done",
      failed: "failed",
      cancelled: "cancelled",
    },
    hubOn: "Hub: running",
    hubOff: "Hub: off — past history only",
    hubUnknown: "Hub: unknown",
    sessions: "sessions",
    people_n: (n) => `${n} participant${n === 1 ? "" : "s"}`,
    tasks_n: (n) => `${n} task${n === 1 ? "" : "s"}`,
    none: "No channels yet.",
    noMatch: "No matches.",
    noTasks: "No tasks.",
    noNotes: "No notes.",
    reopen: "Open the address again — run `npx pluriply view`.",
    changed: "The server changed — open it again (`npx pluriply view`).",
    down: "Disconnected — run `npx pluriply view` to reopen",
    now: "just now",
    min: (n) => `${n} min ago`,
    hour: (n) => `${n} h ago`,
    dur: (m, s) => `${m}m ${s}s`,
    noReply: (d) => `no reply ${d}d`,
    days: (d) => `${d}d`,
  },
  ko: {
    channels: "채널",
    search: "요청·응답·메모 검색",
    people: "참여자",
    tasks: "태스크",
    notes: "공유 메모",
    request: "요청",
    result: "응답",
    attachments: "첨부",
    flow: "상태 흐름",
    worker: "(워커)",
    review: "리뷰",
    sent: "보냄",
    working: "진행 중",
    status: {
      submitted: "보냄",
      working: "진행 중",
      completed: "완료",
      failed: "실패",
      cancelled: "취소",
    },
    hubOn: "허브: ● 실행 중",
    hubOff: "허브: ○ 꺼짐 — 지난 내역만",
    hubUnknown: "허브: 알 수 없음",
    sessions: "세션",
    people_n: (n) => `${n}명`,
    tasks_n: (n) => `태스크 ${n}`,
    none: "아직 채널이 없습니다.",
    noMatch: "결과가 없습니다.",
    noTasks: "태스크가 없습니다.",
    noNotes: "메모가 없습니다.",
    reopen: "주소를 다시 열어 주세요 — `npx pluriply view`",
    changed: "서버가 바뀌었습니다 — 다시 열어 주세요 (`npx pluriply view`).",
    down: "연결이 끊겼습니다 — `npx pluriply view` 로 다시 열어 주세요",
    now: "방금",
    min: (n) => `${n}분 전`,
    hour: (n) => `${n}시간 전`,
    dur: (m, s) => `${m}분 ${s}초`,
    noReply: (d) => `응답 없음 ${d}일`,
    days: (d) => `${d}일`,
  },
};
const L = (navigator.language || "").toLowerCase().startsWith("ko")
  ? T.ko
  : T.en;
// model.js 의 STALE_OPEN_MS 와 같은 값 — "응답 없음 N일" 표시에만 쓴다(활동 중 판정은 activeUntil)
const STALE_OPEN_MS = 86_400_000;

const state = {
  key: null,
  version: null,
  channels: new Map(),
  hub: { running: false, sessionCount: 0 },
  selected: null,
  query: "",
  open: new Set(), // 펼친 태스크("코드/taskId")·메모("코드/memo/entryId")·메모 구역
  stopped: false,
  down: false, // 서버와 연결이 끊겨 다시 잇는 중(띠를 보이는 동안)
};

const $ = (id) => document.getElementById(id);

/** 요소 만들기: 글은 textContent 로만. */
function el(tag, cls, text, kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  for (const k of kids || []) if (k) e.append(k);
  return e;
}

const ms = (v) => {
  const n = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const pad = (n) => String(n).padStart(2, "0");

function clock(v) {
  const t = ms(v);
  if (!t) return "";
  const d = new Date(t);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return Date.now() - t > 86_400_000
    ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
    : hm;
}

function ago(v) {
  const t = ms(v);
  if (!t) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return L.now;
  if (diff < 3_600_000) return L.min(Math.floor(diff / 60_000));
  if (diff < 86_400_000) return L.hour(Math.floor(diff / 3_600_000));
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 길이 표시: 1시간 미만 m:ss, 하루 미만 h:mm, 그 이상은 일. */
function span(sec) {
  if (sec < 3600) return `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
  if (sec < 86_400)
    return `${Math.floor(sec / 3600)}:${pad(Math.floor((sec % 3600) / 60))}`;
  return L.days(Math.floor(sec / 86_400));
}
const elapsed = (from, to) => span(Math.max(0, Math.floor((to - from) / 1000)));

function took(t) {
  const s = Math.max(0, Math.floor((ms(t.updatedAt) - ms(t.createdAt)) / 1000));
  return s < 3600 ? L.dur(Math.floor(s / 60), s % 60) : span(s);
}

const isStale = (t) => Date.now() - ms(t.createdAt) >= STALE_OPEN_MS;

/** 활동 중 판정 — 모델(model.js)이 정한 activeUntil 까지만(규칙을 여기서 다시 쓰지 않는다). */
const isActive = (ch) =>
  typeof ch.activeUntil === "number" && Date.now() < ch.activeUntil;

/** 허브 상태 이름 → 화면 글. 모르는 상태는 그대로. */
const statusLabel = (s) =>
  typeof s === "string" && Object.hasOwn(L.status, s) ? L.status[s] : (s ?? "");

const resultText = (r) =>
  typeof r === "string" ? r : r == null ? "" : JSON.stringify(r, null, 2);

function searchable(ch) {
  const parts = [ch.code];
  for (const t of ch.tasks) parts.push(t.request, resultText(t.result));
  for (const c of ch.context) parts.push(c.summary);
  return parts
    .filter((p) => typeof p === "string")
    .join("\n")
    .toLowerCase();
}

function visibleChannels() {
  const q = state.query.trim().toLowerCase();
  return [...state.channels.values()]
    .filter((ch) => !q || searchable(ch).includes(q))
    .sort(
      (a, b) =>
        Number(isActive(b)) - Number(isActive(a)) ||
        ms(b.lastActivityAt) - ms(a.lastActivityAt),
    );
}

function md(text) {
  return el("div", "md", null, [
    renderMarkdown(
      parseMarkdown(typeof text === "string" ? text : ""),
      document,
    ),
  ]);
}

function toggle(key) {
  if (state.open.has(key)) state.open.delete(key);
  else state.open.add(key);
  renderMain();
}

function select(code) {
  state.selected = code;
  history.replaceState(null, "", `#${code}`);
  render();
}

// ---- 그리기 ----

/** 목록 칸만 다시 그린다 — 검색 상자는 처음 한 번만 만들어 입력(한글 조합)·포커스가 끊기지 않게 한다. */
function renderSide() {
  const list = $("chlist");
  if (!list) return;
  const chans = visibleChannels();
  const rows = chans.map((ch) => {
    const row = el("button", `ch${ch.code === state.selected ? " sel" : ""}`);
    row.type = "button";
    row.append(
      el("span", isActive(ch) ? "dot on" : "dot"),
      el("b", null, ch.code),
      el(
        "span",
        "muted",
        `${L.people_n(ch.participants.length)} · ${L.tasks_n(ch.tasks.length)} · ${ago(ch.lastActivityAt)}`,
      ),
    );
    row.addEventListener("click", () => select(ch.code));
    return row;
  });
  if (!rows.length)
    rows.push(el("div", "muted pad", state.query ? L.noMatch : L.none));
  list.replaceChildren(...rows);
}

function buildSide() {
  const search = el("input", "search");
  search.type = "search";
  search.placeholder = L.search;
  let composing = false;
  const apply = () => {
    state.query = search.value;
    renderSide();
    renderMain();
  };
  search.addEventListener("compositionstart", () => (composing = true));
  search.addEventListener("compositionend", () => {
    composing = false;
    apply();
  });
  search.addEventListener("input", (e) => {
    if (!composing && !e.isComposing) apply();
  });
  const chlist = el("div", "chlist");
  chlist.id = "chlist";
  // 검색 상자는 목록 위에 두어 채널이 많아도 항상 보인다(목록만 스크롤)
  $("side").replaceChildren(el("div", "label", L.channels), search, chlist);
}

function chip(p) {
  return el("span", "chip", null, [
    el("span", p.online ? "dot on" : "dot"),
    el("span", null, p.worker ? `${p.id} ${L.worker}` : p.id),
  ]);
}

function badge(kind, text) {
  return el("span", `tag ${kind}`, text);
}

function taskNode(ch, t) {
  const key = `${ch.code}/${t.taskId}`;
  const isOpen = state.open.has(key);
  const head = el("button", "taskhead");
  head.type = "button";
  head.append(el("span", "caret", isOpen ? "▾" : "▸"));
  if (t.kind === "review") head.append(badge("rev", L.review));
  const label = statusLabel(t.status);
  const stale = t.open && isStale(t);
  const st = badge(
    stale ? "stale" : t.open ? "run" : t.status === "failed" ? "fail" : "done",
    stale
      ? `${label} · ${L.noReply(Math.floor((Date.now() - ms(t.createdAt)) / 86_400_000))}`
      : label,
  );
  if (t.open && !stale) {
    const clockEl = el(
      "span",
      "tick",
      ` ${elapsed(ms(t.createdAt), Date.now())}`,
    );
    clockEl.dataset.since = String(ms(t.createdAt));
    st.append(clockEl);
  } else if (!t.open && ms(t.createdAt) && ms(t.updatedAt)) {
    st.append(el("span", null, ` ${took(t)}`));
  }
  head.append(
    st,
    el("b", "who", `${t.from ?? "?"} → ${t.to ?? "?"}`),
    el("span", "preview", t.preview || ""),
    el("span", "muted time", clock(t.createdAt)),
  );
  head.addEventListener("click", () => toggle(key));
  const row = el("div", `task${isOpen ? " open" : ""}`, null, [head]);
  if (!isOpen) return row;

  const body = el("div", "taskbody");
  body.append(
    el("div", "box req", null, [el("b", null, L.request), md(t.request)]),
  );
  if (t.result !== undefined && t.result !== null && t.result !== "") {
    const res =
      typeof t.result === "string"
        ? md(t.result)
        : el("div", "md", null, [
            renderMarkdown(
              [{ type: "code", text: resultText(t.result) }],
              document,
            ),
          ]);
    body.append(el("div", "box res", null, [el("b", null, L.result), res]));
  }
  if (Array.isArray(t.attachments) && t.attachments.length) {
    const ul = el("ul", "attach");
    for (const a of t.attachments)
      ul.append(
        el(
          "li",
          null,
          typeof a === "string" ? a : (a?.name ?? JSON.stringify(a)),
        ),
      );
    body.append(el("div", "box", null, [el("b", null, L.attachments), ul]));
  }
  body.append(flowNode(t));
  row.append(body);
  return row;
}

/** 상태 흐름: 보냄 → (진행 중) → events → 끝 상태. */
function flowNode(t) {
  const ul = el("ul", "flow");
  const add = (when, text) =>
    ul.append(
      el("li", null, null, [el("span", "muted", `${clock(when)} `), text]),
    );
  add(t.createdAt, L.sent);
  if (t.status && t.status !== "submitted") add("", L.working);
  for (const e of t.events || [])
    add(e.at, [e.kind, e.detail].filter(Boolean).join(" — "));
  if (!t.open && t.status !== "submitted")
    add(t.updatedAt, statusLabel(t.status));
  return el("div", "box", null, [el("b", null, L.flow), ul]);
}

function renderMain() {
  const main = $("main");
  const keep = main.scrollTop;
  const ch = state.channels.get(state.selected);
  if (!ch) {
    main.replaceChildren(el("div", "muted pad", L.none));
    return;
  }
  const q = state.query.trim().toLowerCase();
  const people = el("div", "chips", null, ch.participants.map(chip));
  const tasks = el("div", "tasks");
  for (const t of ch.tasks) tasks.append(taskNode(ch, t));
  if (!ch.tasks.length) tasks.append(el("div", "muted", L.noTasks));
  const notes = el("div", "tasks");
  for (const c of ch.context) {
    const key = `${ch.code}/memo/${c.entryId}`;
    const isOpen =
      state.open.has(key) || (q && (c.summary || "").toLowerCase().includes(q));
    const head = el("button", "taskhead");
    head.type = "button";
    head.append(
      el("span", "caret", isOpen ? "▾" : "▸"),
      el("b", "who", c.from ?? "?"),
      isOpen ? null : el("span", "preview", (c.summary || "").slice(0, 120)),
      el("span", "muted time", clock(c.at)),
    );
    head.addEventListener("click", () => toggle(key));
    const row = el("div", `task${isOpen ? " open" : ""}`, null, [head]);
    if (isOpen) row.append(el("div", "taskbody", null, [md(c.summary)]));
    notes.append(row);
  }
  if (!ch.context.length) notes.append(el("div", "muted", L.noNotes));
  main.replaceChildren(
    el("div", "label", `${ch.code} · ${L.people}`),
    people,
    el("div", "label gap", L.tasks),
    tasks,
    el("div", "label gap", L.notes),
    notes,
  );
  main.scrollTop = keep;
}

function renderHub() {
  const h = state.hub;
  // 끊긴 동안엔 허브 상태를 모른다 — 살아 있는 것처럼 보이지 않게
  $("hubline").textContent = state.down
    ? L.hubUnknown
    : h.running
      ? `${L.hubOn} · ${L.sessions} ${h.sessionCount}`
      : L.hubOff;
}

function pickSelected() {
  if (state.selected && state.channels.has(state.selected)) return;
  const fromHash = location.hash.slice(1);
  const all = visibleChannels();
  state.selected = state.channels.has(fromHash)
    ? fromHash
    : (all.find(isActive) || all[0] || {}).code || null;
}

function render() {
  pickSelected();
  renderSide();
  renderMain();
  renderHub();
}

/** 연결 끊김 띠를 켜고 끈다(다시 잇기는 계속한다). */
function setDown(down) {
  if (state.down === down) return;
  state.down = down;
  const banner = $("banner");
  banner.textContent = down ? L.down : "";
  banner.hidden = !down;
  renderHub();
}

function notice(text) {
  state.stopped = true;
  $("banner").hidden = true;
  $("side").hidden = true; // 목록 칸(#chlist)은 지우지 않고 숨기기만 한다
  $("app").classList.add("solo");
  $("main").replaceChildren(el("div", "notice", text));
  $("hubline").textContent = "";
}

// ---- 통신 ----

class Fatal extends Error {}

async function api(path) {
  const res = await fetch(path, {
    headers: { "X-Pluriply-View-Key": state.key },
    cache: "no-store",
  });
  if (res.status === 403) throw new Fatal("forbidden");
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res;
}

function loadSnapshot(snap) {
  state.channels = new Map(snap.channels.map((c) => [c.code, c]));
  state.hub = snap.hub;
  render();
}

function onEvent(name, data) {
  if (name === "channel") {
    const before = state.selected;
    state.channels.set(data.code, data);
    pickSelected();
    renderSide();
    // 본문은 보고 있는 채널이 바뀌었을 때만 다시 그린다(펼침·스크롤·선택 글이 흔들리지 않게)
    if (data.code === state.selected || state.selected !== before) renderMain();
  } else if (name === "sessions") {
    state.hub = data.hub;
    renderHub();
    // 접속 표시(초록 점)가 바뀌므로 참여자 칩을 다시 그린다
    const online = new Set((data.sessions || []).map((s) => s.instanceId));
    for (const ch of state.channels.values())
      for (const p of ch.participants) p.online = online.has(p.id);
    renderMain();
  }
}

/**
 * 스트림을 먼저 열고 hello 를 받은 뒤 스냅샷을 받는다 — 그 사이 바뀐 것은 스트림에 쌓여 스냅샷 뒤에
 * 그대로 반영된다. 스냅샷까지 맞추면 onUp 을 부른다. SSE 본문을 fetch 로 읽어 이벤트로 나누고,
 * 연결이 끊기면 반환한다.
 * @param {() => void} onUp
 */
async function stream(onUp) {
  const res = await api("/api/events");
  const reader = res.body.getReader();
  try {
    await readEvents(reader, onUp);
  } finally {
    reader.cancel().catch(() => {}); // 그만 읽을 때 연결도 닫아 서버의 유휴 종료를 막지 않는다
  }
}

async function readEvents(reader, onUp) {
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let name = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length) continue;
      let parsed;
      try {
        parsed = JSON.parse(data.join("\n"));
      } catch {
        continue; // 깨진 이벤트는 건너뛴다
      }
      if (name === "hello") {
        // 같은 주소에 다른 버전 서버가 떴다
        if (parsed?.version !== state.version) throw new Fatal("version");
        loadSnapshot(await (await api("/api/snapshot")).json());
        onUp();
        continue;
      }
      try {
        onEvent(name, parsed);
      } catch (e) {
        console.error(e); // 그리기 오류는 보이게 두되 스트림은 계속 읽는다
      }
    }
  }
}

async function healthVersion() {
  const res = await api("/health");
  return (await res.json()).version;
}

async function run() {
  try {
    state.version = await healthVersion();
  } catch {
    return notice(L.changed);
  }
  // 서버가 사라지면(새 서버는 포트·키가 다르다) 네트워크 오류만 난다 — 연속 실패를 세어 띠를 보인다
  const tries = makeReconnect();
  while (!state.stopped) {
    let up = false;
    try {
      // 접속할 때마다 스냅샷을 다시 받아 지워진 채널·놓친 이벤트를 맞춘다
      await stream(() => {
        up = true;
        tries.ok();
        setDown(false);
      });
    } catch (e) {
      if (e instanceof Fatal) return notice(L.changed);
    }
    if (!up && tries.fail()) setDown(true);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      if ((await healthVersion()) !== state.version) return notice(L.changed);
    } catch (e) {
      if (e instanceof Fatal) return notice(L.changed);
    }
  }
}

// ---- 시작 ----

function start() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.key = params.get("key");
  // 키는 메모리에만 두고 주소에서 지운다(채널 선택만 남김)
  const sel = location.hash.slice(1).startsWith("plp-")
    ? location.hash.slice(1)
    : "";
  history.replaceState(null, "", sel ? `#${sel}` : location.pathname);
  if (!state.key) return notice(L.reopen);
  buildSide();
  document.documentElement.lang = L === T.ko ? "ko" : "en";
  run();
  // 상대 시각·활동 중 판정은 1분마다, 진행 중 경과는 1초마다 다시 계산
  setInterval(() => {
    if (!state.stopped) {
      renderSide();
      renderMain();
    }
  }, 60_000);
  setInterval(() => {
    // 끊긴 동안엔 경과 시각을 멈춘다 — 살아 있는 것처럼 보이지 않게
    if (state.down || state.stopped) return;
    for (const s of document.querySelectorAll("[data-since]"))
      s.textContent = ` ${elapsed(Number(s.dataset.since), Date.now())}`;
  }, 1000);
}

start();
