/**
 * room.js — Room and player management
 * Create/join/leave room, player list rendering, reconnect logic
 */

import {
  ref, set, get, update, remove, onValue
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { db, DB_PREFIX, STATE, showView } from "./app.js";
import { startGame, getRoleConfig, startVotingPhase, startPhaseTimer, stopPhaseTimer, resetToLobby, getSeerResult, submitNightAction } from "./game.js";
import { initChat, destroyChat, refreshChatTabs } from "./chat.js";
import { renderVoting, resolveVotes, resetVoteSelection } from "./voting.js";

// ─── Room Create ───────────────────────────────────────────────────────────────

export async function createRoom(playerName) {
  const roomId = generateRoomCode();
  STATE.roomId = roomId;
  STATE.playerName = playerName;
  STATE.isHost = true;

  const roomData = {
    hostId: STATE.playerId,
    status: "waiting",
    phase: null,
    dayCount: 0,
    timerEnd: null,
    maxPlayers: 16,
    createdAt: Date.now(),
    nightActions: null,
    lastElimination: null,
    winnerTeam: null,
    players: {
      [STATE.playerId]: makePlayerRecord(playerName, true),
    },
  };

  await set(ref(db, `${DB_PREFIX}/rooms/${roomId}`), roomData);
  subscribeToRoom();
}

// ─── Room Join ────────────────────────────────────────────────────────────────

export async function joinRoom(roomId, playerName) {
  const roomRef = ref(db, `${DB_PREFIX}/rooms/${roomId}`);
  const snapshot = await get(roomRef);

  if (!snapshot.exists()) throw new Error("ไม่พบห้องนี้ ตรวจรหัสห้องและลองใหม่");
  const room = snapshot.val();
  if (room.status === "ended") throw new Error("เกมนี้จบไปแล้ว");

  // Duplicate name check
  const players = room.players || {};
  const names = Object.values(players).map(p => p.name.toLowerCase());
  if (names.includes(playerName.toLowerCase())) {
    throw new Error(`ชื่อ "​${playerName}" ถูกใช้แล้ว เลือกชื่ออื่นนะคะ`);
  }

  // Max players check
  if (Object.keys(players).length >= (room.maxPlayers || 16)) {
    throw new Error("ห้องเต็มแล้ว");
  }

  STATE.roomId = roomId;
  STATE.playerName = playerName;
  STATE.isHost = false;

  // Handle reconnect — if player was in this room
  const existingEntry = Object.entries(players).find(([, p]) => p.name.toLowerCase() === playerName.toLowerCase());
  let pid = STATE.playerId;
  if (existingEntry) {
    pid = existingEntry[0];
    STATE.playerId = pid;
  }

  await update(ref(db, `${DB_PREFIX}/rooms/${roomId}/players/${pid}`), makePlayerRecord(playerName, false));
  subscribeToRoom();
}

// ─── Leave Room ───────────────────────────────────────────────────────────────

export async function leaveRoom() {
  stopPhaseTimer();
  destroyChat();
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }

  try {
    const playerRef = ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}`);
    await remove(playerRef);

    if (STATE.isHost) {
      // Transfer host to next alive player or delete room
      const snap = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players`));
      const remaining = snap.val();
      if (remaining && Object.keys(remaining).length > 0) {
        const newHostId = Object.keys(remaining)[0];
        await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
          hostId: newHostId,
        });
        await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${newHostId}`), {
          isHost: true,
        });
      } else {
        await remove(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`));
      }
    }
  } catch (e) { /* ignore */ }

  resetState();
  showView("home");
}

// ─── Kick Player ──────────────────────────────────────────────────────────────

export async function kickPlayer(targetId) {
  if (!STATE.isHost) return;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${targetId}`), { kicked: true });
  setTimeout(async () => {
    await remove(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${targetId}`));
  }, 1500);
}

// ─── Subscription ─────────────────────────────────────────────────────────────

let unsubRoom = null;
let lastPhase = null;
let lastStatus = null;

export function subscribeToRoom() {
  if (unsubRoom) unsubRoom();
  const roomRef = ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`);

  const displayCode = document.getElementById("display-room-code");
  if (displayCode) displayCode.textContent = STATE.roomId;

  unsubRoom = onValue(roomRef, async (snapshot) => {
    if (!snapshot.exists()) {
      showKickedToast("ห้องถูกปิดแล้ว");
      resetState();
      showView("home");
      return;
    }

    STATE.roomData = snapshot.val();
    const me = STATE.roomData.players?.[STATE.playerId];

    // Was kicked?
    if (!me) {
      showKickedToast("คุณถูกเญียนออกจากห้อง");
      if (unsubRoom) { unsubRoom(); unsubRoom = null; }
      resetState();
      showView("home");
      return;
    }

    if (me.kicked) return; // Wait for remove

    STATE.isHost = STATE.roomData.hostId === STATE.playerId;

    const { status, phase } = STATE.roomData;

    // Phase/status transition handlers
    if (status !== lastStatus || phase !== lastPhase) {
      stopPhaseTimer();
      lastStatus = status;
      lastPhase = phase;

      if (status === "waiting") {
        showView("lobby");
        renderLobby(STATE.roomData);
        destroyChat();
      } else if (status === "playing") {
        showView("game");
        initChatIfNeeded();
        renderGameScreen(STATE.roomData);
        // Start timer
        if (STATE.roomData.timerEnd) {
          startPhaseTimer(STATE.roomData.timerEnd, phase);
        }
      } else if (status === "ended") {
        showView("result");
        stopPhaseTimer();
        renderResultScreen(STATE.roomData);
      }
    } else {
      // Same status — just re-render current view
      if (status === "waiting") renderLobby(STATE.roomData);
      else if (status === "playing") renderGameScreen(STATE.roomData);
    }
  });
}

let chatInited = false;
function initChatIfNeeded() {
  if (!chatInited) {
    initChat();
    chatInited = true;
  }
}

// ─── Lobby Rendering ──────────────────────────────────────────────────────────

export function renderLobby(roomData) {
  const players = roomData.players || {};
  const ids = Object.keys(players);
  const me = players[STATE.playerId];

  document.getElementById("lobby-player-count").textContent = `${ids.length} / ${roomData.maxPlayers || 16}`;

  const readyCount = ids.filter(id => players[id].isReady).length;
  const allReady = readyCount === ids.length && ids.length >= 4;

  // Player list
  document.getElementById("lobby-player-list").innerHTML = ids.map(id => {
    const p = players[id];
    const isMe = id === STATE.playerId;
    const isHost = id === roomData.hostId;
    return `
      <div class="lobby-player ${isMe ? 'lobby-player-me' : ''}">
        <div class="lobby-player-left">
          <div class="lobby-avatar">${p.name.charAt(0).toUpperCase()}</div>
          <div class="lobby-info">
            <span class="lobby-name">${escapeHtml(p.name)} ${isMe ? "<span class='you-badge'>คุณ</span>" : ""}</span>
            <span class="lobby-host-badge ${isHost ? '' : 'hidden'}">👑 โฮสต์</span>
          </div>
        </div>
        <div class="lobby-player-right">
          <span class="ready-badge ${p.isReady ? 'ready-yes' : 'ready-no'}">${p.isReady ? '✅ พร้อม' : '⏳ ยังไม่พร้อม'}</span>
          ${STATE.isHost && !isMe ? `<button class="btn-kick" onclick="window._kickPlayer('${id}')">🥾</button>` : ''}
        </div>
      </div>`;
  }).join("");

  // Ready button
  const readyBtn = document.getElementById("btn-ready");
  if (readyBtn) {
    readyBtn.querySelector(".front").textContent = me?.isReady ? "❌ ยกเลิกความพร้อม" : "✅ พร้อมแล้ว!";
    readyBtn.classList.toggle("btn-ready-active", !!me?.isReady);
  }

  // Host controls
  const hostControls = document.getElementById("host-controls");
  if (hostControls) hostControls.classList.toggle("hidden", !STATE.isHost);

  // Start button
  const startBtn = document.getElementById("btn-start-game");
  if (startBtn && STATE.isHost) {
    const canStart = allReady && ids.length >= 4;
    startBtn.disabled = !canStart;
    startBtn.querySelector(".front").textContent = ids.length < 4
      ? `🐺 เริ่มเกม (ต้องการอีก ${4 - ids.length} คน)`
      : !allReady
        ? `⏳ รอความพร้อม... (${readyCount}/${ids.length} พร้อม)`
        : "🐺 เริ่มเกม!";
  }
}

// ─── Game Screen Rendering ────────────────────────────────────────────────────

let lastElimKey = null;

export function renderGameScreen(roomData) {
  const players = roomData.players || {};
  const me = players[STATE.playerId];
  const phase = roomData.phase;

  // Update timer if changed
  if (roomData.timerEnd && roomData.timerEnd !== STATE._lastTimerEnd) {
    STATE._lastTimerEnd = roomData.timerEnd;
    startPhaseTimer(roomData.timerEnd, phase);
  }

  // Phase banner
  const phaseBanner = document.getElementById("phase-banner");
  if (phaseBanner) {
    phaseBanner.className = `phase-banner phase-${phase}`;
    phaseBanner.querySelector(".phase-icon").textContent = phase === "night" ? "🌙" : phase === "voting" ? "🗳️" : "☀️";
    phaseBanner.querySelector(".phase-label").textContent =
      phase === "night" ? `คืนที่ ${roomData.dayCount}` :
      phase === "voting" ? "ถึงเวลาโหวต!" : `กลางวันที่ ${roomData.dayCount}`;
  }

  // Render role card (always)
  renderRoleCard(me, roomData);

  // Render player list (always)
  renderPlayerList(players, roomData.hostId, phase);

  // Phase-specific panels (set display directly since HTML uses style.display:none)
  const nightPanel = document.getElementById("night-panel");
  const dayPanel = document.getElementById("day-panel");
  const votePanel = document.getElementById("vote-panel");
  if (nightPanel) nightPanel.style.display = phase === "night" ? "block" : "none";
  if (dayPanel) dayPanel.style.display = phase === "day" ? "block" : "none";
  if (votePanel) votePanel.style.display = phase === "voting" ? "block" : "none";

  if (phase === "night") renderNightPanel(me, players);
  if (phase === "day") renderDayPanel(me);
  if (phase === "voting") {
    renderVoting(roomData);
    resetVoteSelection();
  }

  // Elimination announcement
  const elim = roomData.lastElimination;
  const delimKey = elim ? `${elim.playerId}-${elim.timestamp}` : null;
  if (elim && delimKey !== lastElimKey) {
    lastElimKey = delimKey;
    showEliminationBanner(elim);
  }

  // Seer result (private)
  if (me?.role === "seer") {
    getSeerResult().then(result => {
      if (result) showSeerResult(result);
    });
  }

  // Chat tabs visibility
  refreshChatTabs();
}

function renderRoleCard(me, roomData) {
  if (!me) return;
  const cfg = getRoleConfig(me.role);
  const card = document.getElementById("role-card");
  if (!card) return;

  card.style.setProperty("--role-color", cfg.color);
  document.getElementById("role-icon").textContent = cfg.icon;
  document.getElementById("role-name").textContent = cfg.name;
  document.getElementById("role-desc").textContent = cfg.description;
  card.classList.toggle("role-dead", !me.isAlive);

  // Show wolf allies
  const wolfInfo = document.getElementById("wolf-allies");
  if (wolfInfo) {
    if (me.role === "werewolf") {
      const allies = Object.entries(roomData.players || {})
        .filter(([id, p]) => p.role === "werewolf" && id !== STATE.playerId)
        .map(([, p]) => p.name);
      wolfInfo.classList.toggle("hidden", allies.length === 0);
      wolfInfo.textContent = allies.length > 0 ? `🐺 Allies: ${allies.join(", ")}` : "";
    } else {
      wolfInfo.classList.add("hidden");
    }
  }
}

function renderNightPanel(me, players) {
  const panel = document.getElementById("night-panel");
  if (!me?.isAlive) {
    panel.innerHTML = `<div class="night-dead-msg">💀 You have been eliminated. Watch quietly...</div>`;
    return;
  }

  const role = me.role;
  const targets = Object.entries(players)
    .filter(([id, p]) => p.isAlive && id !== STATE.playerId && (role !== "werewolf" || p.role !== "werewolf"));

  let actionDone = false;
  const actionKey = { werewolf: "werewolfTargetDone", seer: "seerTargetDone", doctor: "doctorTargetDone" }[role];
  if (actionKey) actionDone = !!STATE.roomData?.nightActions?.[actionKey];

  if (role === "villager") {
    panel.innerHTML = `<div class="night-waiting"><div class="moon-anim">🌙</div><p>รอให้คืนผ่านไป...</p><p style="color:var(--text-muted);font-size:0.84rem">ชาวบ้านธรรมดา อยู่เงียบๆ ในคืนนี้</p></div>`;
    return;
  }

  const actionLabel = { werewolf: "🌙 เลือกเหยื่อของคุณ", seer: "🔮 เลือกคนที่ต้องการตรวจสอบ", doctor: "💉 เลือกคนที่ต้องการป้องกัน" }[role] || "เลือกเป้าหมาย";
  const btnLabel = { werewolf: "🐺 โจมตี!", seer: "🔮 สำรวจ!", doctor: "💉 รักษา!" }[role] || "ยืนยัน";

  if (actionDone) {
    panel.innerHTML = `<div class="night-done"><span class="check-anim">✅</span><p>ส่งการกระทำแล้ว รอคนอื่น...</p></div>`;
    return;
  }

  panel.innerHTML = `
    <div class="night-action" style="padding:16px">
      <p class="night-action-label">${actionLabel}</p>
      <div class="night-target-grid" id="night-target-grid">
        ${targets.length === 0
          ? `<p style="color:var(--text-muted);font-size:0.84rem;grid-column:1/-1;text-align:center">ไม่มีเป้าหมายได้ในขณะนี้</p>`
          : targets.map(([id, p]) => `
          <button class="night-target-btn" onclick="window._nightAction('${role}', '${id}', this)">
            <div class="night-avatar">${p.name.charAt(0).toUpperCase()}</div>
            <span>${escapeHtml(p.name)}</span>
          </button>`).join("")}
      </div>
    </div>`;
}

function renderDayPanel(me) {
  const panel = document.getElementById("day-panel");
  if (!me?.isAlive) {
    panel.innerHTML = `<div class="day-dead-msg">💀 คุณถูกตัดสิทธิ์แล้ว ยังดูแลคุยในช่อง "ผีสิง" ได้นะ</div>`;
    return;
  }
  panel.innerHTML = `
    <div class="day-instructions">
      <div class="day-sun-icon">☀️</div>
      <h4>ช่วงกลางวัน — คุยกันและค้นหาหมาป่า!</h4>
      <p>พูดคุยในแชต์ โหวตเริ่มเมื่อเวลาหมดหรือโฮสต์กดเริ่ม</p>
    </div>`;

  // Host can manually start vote
  const hostVoteBtn = document.getElementById("host-start-vote");
  if (hostVoteBtn) hostVoteBtn.classList.toggle("hidden", !STATE.isHost);
}

function renderPlayerList(players, hostId, phase) {
  const list = document.getElementById("game-player-list");
  if (!list) return;
  const me = players[STATE.playerId];
  const myRole = me?.role;

  list.innerHTML = Object.entries(players).map(([id, p]) => {
    const status = p.isAlive ? "alive" : "dead";
    const isMe = id === STATE.playerId;
    const isHost = id === hostId;
    // Wolves can see other wolves
    let roleHint = "";
    if (myRole === "werewolf" && p.role === "werewolf" && id !== STATE.playerId) {
      roleHint = `<span class="wolf-hint">🐺</span>`;
    }
    return `
      <div class="player-status player-${status} ${isMe ? 'player-me' : ''}">
        <div class="ps-avatar ${status}">${p.name.charAt(0).toUpperCase()}</div>
        <span class="ps-name">${escapeHtml(p.name)} ${isMe ? '<em>(คุณ)</em>' : ''} ${isHost ? '👑' : ''} ${roleHint}</span>
        <span class="ps-status">${p.isAlive ? '' : '💀'}</span>
      </div>`;
  }).join("");
}

function showEliminationBanner(elim) {
  const banner = document.getElementById("elimination-banner");
  if (!banner) return;

  let text = "";
  if (elim.reason === "protected") {
    text = "🛡️ แพทย์ช่วยเหลือ! ไม่มีใครตายในคืนนี้";
  } else if (elim.reason === "no-action") {
    text = "🌙 คืนอันเงียบสงัด... ไม่มีใครเสียชีวิต";
  } else if (elim.reason === "werewolf") {
    text = `🐺 ${elim.playerName} ถูกหมาป่าสังหาร! พวกเขาคือ ${getRoleConfig(elim.playerRole).name}`;
  } else if (elim.reason === "vote") {
    text = `🗳️ ${elim.playerName} ถูกโหวตไล่ออก! พวกเขาคือ ${getRoleConfig(elim.playerRole).name}`;
  }

  banner.textContent = text;
  banner.classList.remove("hidden");
  banner.classList.add("animate-bounce-in");
  setTimeout(() => {
    banner.classList.add("hidden");
    banner.classList.remove("animate-bounce-in");
  }, 6000);
}

function showSeerResult(result) {
  const el = document.getElementById("seer-result");
  if (!el) return;
  const cfg = getRoleConfig(result.targetRole);
  el.innerHTML = `🔮 <strong>${result.targetName}</strong> is a <strong style="color:${cfg.color}">${cfg.icon} ${cfg.name}</strong>`;
  el.classList.remove("hidden");
}

// ─── Result Screen ────────────────────────────────────────────────────────────

export function renderResultScreen(roomData) {
  const winner = roomData.winnerTeam;
  const players = roomData.players || {};

  const banner = document.getElementById("result-banner");
  if (banner) {
    banner.className = `result-banner result-${winner}`;
    banner.querySelector(".result-icon").textContent = winner === "werewolf" ? "🐺" : "🏘️";
    banner.querySelector(".result-title").textContent = winner === "werewolf" ? "หมาป่าชนะ!" : "ชาวบ้านชนะ!";
    banner.querySelector(".result-subtitle").textContent = winner === "werewolf"
      ? "หมู่บ้านตกอยู่ในความมืด หมาป่าครองคืนแล้ว..."
      : "หมู่บ้านปลอดภัยแล้ว! หมาป่าทุกตัวถูกจับได้หมดแล้ว";
  }

  // Full role reveal
  const revealList = document.getElementById("result-role-list");
  if (revealList) {
    revealList.innerHTML = Object.entries(players).map(([id, p]) => {
      const cfg = getRoleConfig(p.role);
      const isMe = id === STATE.playerId;
      return `
        <div class="result-player ${p.isAlive ? 'result-alive' : 'result-dead'}">
          <div class="result-avatar" style="background:${cfg.color}22; border-color:${cfg.color}">${p.name.charAt(0).toUpperCase()}</div>
          <div class="result-player-info">
            <span class="result-player-name">${escapeHtml(p.name)} ${isMe ? '<em>(คุณ)</em>' : ''}</span>
            <span class="result-role" style="color:${cfg.color}">${cfg.icon} ${cfg.name}</span>
          </div>
          <span class="result-alive-badge">${p.isAlive ? 'รอดสัตว์' : '💀 ถูกตัดสิทธิ์'}</span>
        </div>`;
    }).join("");
  }

  // Play again (host only)
  const playAgainBtn = document.getElementById("btn-play-again");
  if (playAgainBtn) playAgainBtn.classList.toggle("hidden", !STATE.isHost);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePlayerRecord(name, isHost) {
  return { name, isHost, isAlive: true, isReady: false, role: "", vote: "", kicked: false };
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function resetState() {
  STATE.roomId = null;
  STATE.roomData = null;
  STATE.isHost = false;
  STATE._lastTimerEnd = null;
  chatInited = false;
  lastPhase = null;
  lastStatus = null;
  lastElimKey = null;
}

function showKickedToast(msg) {
  const t = document.createElement("div");
  t.className = "toast-kick";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Global Action Handlers (called from inline HTML) ─────────────────────────

window._kickPlayer = kickPlayer;

window._nightAction = async function (role, targetId, btnEl) {
  // Visual feedback — disable all buttons immediately
  document.querySelectorAll(".night-target-btn").forEach(b => { b.classList.remove("night-selected"); b.disabled = true; });
  btnEl.classList.add("night-selected");

  await submitNightAction(role, targetId);

  // Update UI
  const np = document.getElementById("night-panel");
  if (np) np.innerHTML = `<div class="night-done"><span class="check-anim">✅</span><p>ส่งการกระทำแล้ว รอคนอื่น...</p></div>`;
};
