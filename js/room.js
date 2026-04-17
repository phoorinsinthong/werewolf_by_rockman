/**
 * room.js — Lobby and game screen rendering (GM-aware)
 * Handles Firebase room subscription, lobby rendering, and the
 * split between GM view / player view in the game screen.
 */

import { ref, push, set, get, update, remove, onValue } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { db, DB_PREFIX, STATE } from "./app.js";
import {
  startGame, getRoleConfig, startVotingPhase, startPhaseTimer, stopPhaseTimer,
  resetToLobby, getSeerResult, submitNightAction, startNightPhase,
  gmAnnounceNightResult, announceWinner, resolveNight, ROLES,
} from "./game.js";
import { renderVoting, castVote, resetVoteSelection, resolveVotes, gmSkipVote} from "./voting.js";
import { initChat, setActiveChatTab } from "./chat.js";

let unsubRoom = null;

// ─── Create Room ───────────────────────────────────────────────────────────────

export async function createRoom(playerName) {
  const roomId   = generateRoomCode();
  const roomRef  = ref(db, `${DB_PREFIX}/rooms/${roomId}`);

  STATE.playerId   = STATE.authUser.uid;
  STATE.roomId     = roomId;
  STATE.playerName = playerName;
  STATE.isHost     = true;

  await set(roomRef, {
    hostId: STATE.playerId,
    status: "waiting",
    phase:  null,
    dayCount: 0,
    maxPlayers: 16,
    roleDeckCounts: { werewolf: 1, seer: 1, doctor: 1, villager: 1 },
    players: {
      [STATE.playerId]: {
        name:    playerName,
        isReady: true,   // GM is always ready
        isAlive: true,
        role:    "",
        vote:    "",
      },
    },
    createdAt: Date.now(),
  });

  subscribeToRoom();
  showView("lobby");
}

// ─── Join Room ─────────────────────────────────────────────────────────────────

export async function joinRoom(roomId, playerName) {
  const roomRef  = ref(db, `${DB_PREFIX}/rooms/${roomId}`);
  const snapshot = await get(roomRef);

  if (!snapshot.exists()) throw new Error("ไม่พบห้องนี้ ตรวจรหัสห้องและลองใหม่");
  const room = snapshot.val();
  if (room.status === "ended") throw new Error("เกมนี้จบไปแล้ว");

  const players = room.players || {};
  const names   = Object.values(players).map(p => p.name.toLowerCase());
  if (names.includes(playerName.toLowerCase())) {
    throw new Error(`ชื่อ "${playerName}" ถูกใช้แล้ว เลือกชื่ออื่นนะคะ`);
  }
  if (Object.keys(players).length >= (room.maxPlayers || 16)) {
    throw new Error("ห้องเต็มแล้ว");
  }

  STATE.playerId   = STATE.authUser.uid;
  STATE.roomId     = roomId;
  STATE.playerName = playerName;
  STATE.isHost     = room.hostId === STATE.playerId;

  await update(ref(db, `${DB_PREFIX}/rooms/${roomId}/players/${STATE.playerId}`), {
    name:    playerName,
    isReady: false,
    isAlive: true,
    role:    "",
    vote:    "",
  });

  subscribeToRoom();
  showView("lobby");
}

// ─── Leave Room ────────────────────────────────────────────────────────────────

export async function leaveRoom() {
  if (!STATE.roomId || !STATE.playerId) return;
  if (unsubRoom) { unsubRoom(); unsubRoom = null; }

  const playerRef = ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}`);
  await remove(playerRef);

  if (STATE.isHost) {
    await remove(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`));
  }

  resetState();
  showView("home");
}

// ─── Subscribe to Room ─────────────────────────────────────────────────────────

export function subscribeToRoom() {
  if (unsubRoom) unsubRoom();
  const roomRef = ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`);

  const displayCode = document.getElementById("display-room-code");
  if (displayCode) displayCode.textContent = STATE.roomId;

  let lastStatus = null;
  let lastPhase  = null;

  unsubRoom = onValue(roomRef, async (snapshot) => {
    if (!snapshot.exists()) {
      showKickedToast("ห้องถูกปิดแล้ว");
      resetState();
      showView("home");
      return;
    }

    const roomData = snapshot.val();
    STATE.roomData = roomData;
    STATE.isHost   = roomData.hostId === STATE.playerId;

    const me     = roomData.players?.[STATE.playerId];
    const status = roomData.status || "waiting";
    const phase  = roomData.phase  || null;

    // Kicked?
    if (!me) {
      showKickedToast("คุณถูกเชิญออกจากห้อง");
      if (unsubRoom) { unsubRoom(); unsubRoom = null; }
      resetState();
      showView("home");
      return;
    }

    if (status !== lastStatus || phase !== lastPhase) {
      stopPhaseTimer();
      lastStatus = status;
      lastPhase  = phase;

      if (status === "waiting") {
        showView("lobby");
        renderLobby(roomData);
      } else if (status === "playing") {
        showView("game");
        initChat();
        renderGameScreen(roomData);
        if (roomData.timerEnd && phase !== "night-done") {
          startPhaseTimer(roomData.timerEnd, phase);
        }
      } else if (status === "ended") {
        showView("result");
        renderResult(roomData);
      }
    } else {
      // Same phase — re-render updated data (votes, actions, etc.)
      if (status === "waiting")  renderLobby(roomData);
      if (status === "playing")  renderGameScreenPartial(roomData);
      if (status === "ended")    renderResult(roomData);
    }
  });
}

// ─── Reconnect to Existing Session ────────────────────────────────────────────

export async function reconnectToRoom() {
  if (!STATE.roomId || !STATE.playerId) return;

  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}`));
  if (!snapshot.exists()) {
    showKickedToast("ไม่พบเซสชันเก่า กลับหน้าหลัก");
    resetState();
    showView("home");
    return;
  }

  const roomSnap = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`));
  if (!roomSnap.exists()) {
    showKickedToast("ห้องถูกปิดแล้ว");
    resetState();
    showView("home");
    return;
  }

  STATE.isHost   = roomSnap.val().hostId === STATE.playerId;
  STATE.roomData = roomSnap.val();
  subscribeToRoom();
}

// ─── Render Lobby ──────────────────────────────────────────────────────────────

function renderLobby(roomData) {
  const players    = roomData.players || {};
  const hostId     = roomData.hostId;
  const ids        = Object.keys(players);
  const nonGMIds   = ids.filter(id => id !== hostId);
  const me         = players[STATE.playerId];
  const readyCount = nonGMIds.filter(id => players[id]?.isReady).length;
  const allReady   = readyCount === nonGMIds.length && nonGMIds.length >= 4;

  // Player count badge (non-GM players)
  const countEl = document.getElementById("lobby-player-count");
  if (countEl) countEl.textContent = `${nonGMIds.length} / ${(roomData.maxPlayers || 16) - 1}`;

  // GM row at top
  const gmPlayer = players[hostId];
  const gmIsMe   = hostId === STATE.playerId;
  const gmRow    = gmPlayer ? `
    <div class="lobby-player lobby-player-gm ${gmIsMe ? "lobby-player-me" : ""}">
      <div class="lobby-player-left">
        <div class="lobby-avatar lobby-avatar-gm">🎭</div>
        <div class="lobby-info">
          <span class="lobby-name">${escapeHtml(gmPlayer.name)} ${gmIsMe ? "<span class='you-badge'>คุณ</span>" : ""}</span>
          <span class="gm-badge-label">🎭 ผู้ดำเนินเกม (GM)</span>
        </div>
      </div>
      <div class="lobby-player-right">
        <span class="ready-badge ready-gm">🎭 GM</span>
      </div>
    </div>` : "";

  // Regular player rows
  const playerRows = nonGMIds.map(id => {
    const p      = players[id];
    const isMe   = id === STATE.playerId;
    return `
      <div class="lobby-player ${isMe ? "lobby-player-me" : ""}">
        <div class="lobby-player-left">
          <div class="lobby-avatar">${p.name.charAt(0).toUpperCase()}</div>
          <div class="lobby-info">
            <span class="lobby-name">${escapeHtml(p.name)} ${isMe ? "<span class='you-badge'>คุณ</span>" : ""}</span>
          </div>
        </div>
        <div class="lobby-player-right">
          <span class="ready-badge ${p.isReady ? "ready-yes" : "ready-no"}">${p.isReady ? "✅ พร้อม" : "⏳ ยังไม่พร้อม"}</span>
          ${STATE.isHost && !isMe ? `<button class="btn-kick" onclick="window._kickPlayer('${id}')">🥾</button>` : ""}
        </div>
      </div>`;
  }).join("");

  const listEl = document.getElementById("lobby-player-list");
  if (listEl) listEl.innerHTML = gmRow + playerRows;

  // Ready button — HIDE for GM (host)
  const readyBtn = document.getElementById("btn-ready");
  if (readyBtn) {
    readyBtn.style.display = STATE.isHost ? "none" : "";
    if (!STATE.isHost) {
      readyBtn.querySelector(".front").textContent = me?.isReady ? "❌ ยกเลิกความพร้อม" : "✅ พร้อมแล้ว!";
      readyBtn.classList.toggle("btn-ready-active", !!me?.isReady);
    }
  }

  // Host controls section
  const hostControls = document.getElementById("host-controls");
  if (hostControls) hostControls.classList.toggle("hidden", !STATE.isHost);

  // --- Deck Setup Rendering ---
  const counts = roomData.roleDeckCounts || { werewolf: 1, seer: 1, doctor: 1, villager: 1 };
  const totalDeck = Object.values(counts).reduce((a, b) => a + b, 0);
  const targetPlayers = nonGMIds.length;

  const countSel = document.getElementById("deck-count-selected");
  const countReq = document.getElementById("deck-count-required");
  if (countSel) countSel.textContent = totalDeck;
  if (countReq) countReq.textContent = targetPlayers;

  // Render GM Deck Controls
  if (STATE.isHost) {
    const deckSetupHtml = Object.keys(ROLES).filter(r => r !== "gm").map(rKey => {
      const info = ROLES[rKey];
      const count = counts[rKey] || 0;
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:rgba(0,0,0,0.15); border-radius:6px; margin-bottom:6px;">
          <div>
            <span style="font-size:1.2em; margin-right:8px;">${info.icon}</span>
            <span style="color:${info.color}; font-weight:600;">${info.name}</span>
          </div>
          <div style="display:flex; align-items:center; gap:12px;">
            <button class="btn btn-ghost" style="padding:2px 10px; font-size:1.2em; min-width:32px" onclick="window._updateDeckCount('${rKey}', -1)">-</button>
            <span style="font-weight:bold; font-size:1.1em; width:20px; text-align:center">${count}</span>
            <button class="btn btn-ghost" style="padding:2px 10px; font-size:1.2em; min-width:32px" onclick="window._updateDeckCount('${rKey}', 1)">+</button>
          </div>
        </div>`;
    }).join("");
    const setupContainer = document.getElementById("gm-deck-setup");
    if (setupContainer) setupContainer.innerHTML = deckSetupHtml;
  }

  // Render Public Deck (for all to see)
  const pubDeckHtml = Object.keys(counts).filter(r => counts[r] > 0).map(rKey => {
    const info = ROLES[rKey];
    return `
      <div class="role-info-item" style="border-color:${info.color}40; background:${info.color}10">
        <span class="role-info-icon">${info.icon}</span>
        <span class="role-info-name" style="color:${info.color}">${info.name} <span style="opacity:0.8;font-size:0.8em;margin-left:4px">x${counts[rKey]}</span></span>
        <span class="role-info-desc">${info.description}</span>
      </div>`;
  }).join("");
  const pubContainer = document.getElementById("public-role-deck");
  if (pubContainer) {
    pubContainer.innerHTML = totalDeck > 0 ? pubDeckHtml : `<div class="text-center w-100" style="color: rgba(255,255,255,0.5); padding: 20px;">รอ GM จัดไพ่...</div>`;
  }

  // Start button
  const startBtn = document.getElementById("btn-start-game");
  if (startBtn && STATE.isHost) {
    const deckIsPerfect = totalDeck === targetPlayers && targetPlayers >= 4;
    const canStart = allReady && deckIsPerfect;
    startBtn.disabled = !canStart;
    const front = startBtn.querySelector(".front") || startBtn;
    front.textContent = targetPlayers < 4
      ? `🐺 เริ่มเกม (ต้องการอีก ${4 - targetPlayers} คน)`
      : !allReady
        ? `⏳ รอความพร้อม... (${readyCount}/${targetPlayers} พร้อม)`
        : !deckIsPerfect
          ? `จัดไพ่ไม่พอดี (${totalDeck}/${targetPlayers})`
          : "🎭 เริ่มเกม!";
  }
}

// ─── Render Game Screen (full, on phase change) ────────────────────────────────

function renderGameScreen(roomData) {
  const phase   = roomData.phase || "standby";
  const players = roomData.players || {};
  const me      = players[STATE.playerId];

  // Phase banner
  updatePhaseBanner(phase, roomData.dayCount || 0);

  // Sidebar: player list (always)
  renderPlayerSidebar(players, roomData.hostId);

  // Chat: init tabs based on role
  const myRole = me?.role || "";
  setActiveChatTab("global", myRole, !me?.isAlive);

  // Route to GM or player view
  if (STATE.isHost) {
    showGMPanel();
    renderGMPanel(roomData);
  } else {
    showPlayerPanels();
    renderPlayerGameView(phase, me, players, roomData);
  }
}

// ─── Render Game Partial (same phase, different data) ─────────────────────────

function renderGameScreenPartial(roomData) {
  const phase   = roomData.phase || "standby";
  const players = roomData.players || {};
  const me      = players[STATE.playerId];

  renderPlayerSidebar(players, roomData.hostId);

  if (STATE.isHost) {
    renderGMPanel(roomData);
  } else {
    renderPlayerGameView(phase, me, players, roomData);
  }

  // Seer result update
  if (me?.role === "seer") updateSeerResult();
}

// ─── Phase Banner ──────────────────────────────────────────────────────────────

function updatePhaseBanner(phase, dayCount) {
  const banner = document.getElementById("phase-banner");
  if (!banner) return;

  const phaseMap = {
    standby:    { cls: "phase-standby", icon: "🎭", label: "รอเริ่มรอบ" },
    night:      { cls: "phase-night",   icon: "🌙", label: `คืนที่ ${dayCount}` },
    "night-done": { cls: "phase-night", icon: "🌙", label: `คืนที่ ${dayCount} ✅` },
    day:        { cls: "phase-day",     icon: "☀️", label: `กลางวันที่ ${dayCount}` },
    voting:     { cls: "phase-voting",  icon: "🗳️", label: "ถึงเวลาโหวต!" },
  };

  const { cls, icon, label } = phaseMap[phase] || { cls: "", icon: "🎭", label: phase };
  banner.className = `phase-banner ${cls}`;
  const iconEl  = banner.querySelector(".phase-icon");
  const labelEl = banner.querySelector(".phase-label");
  if (iconEl)  iconEl.textContent  = icon;
  if (labelEl) labelEl.textContent = label;
}

// ─── GM Panel Toggle ───────────────────────────────────────────────────────────

function showGMPanel() {
  document.getElementById("gm-main-panel")?.style.setProperty("display", "flex");
  document.getElementById("gm-main-panel")?.style.setProperty("flex-direction", "column");
  // Hide all player panels
  ["role-card", "night-panel", "day-panel", "vote-panel", "standby-panel"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}

function showPlayerPanels() {
  document.getElementById("gm-main-panel")?.style.setProperty("display", "none");
}

// ─── GM Panel Render ───────────────────────────────────────────────────────────

function renderGMPanel(roomData) {
  const phase   = roomData.phase || "standby";
  const players = roomData.players || {};
  const hostId  = roomData.hostId;

  // 1. Role table
  renderGMRoleTable(players, hostId);

  // 2. Night result card
  const nightCard    = document.getElementById("gm-night-result");
  const nightContent = document.getElementById("gm-night-result-content");
  if (nightCard && nightContent) {
    const visible = phase === "night-done";
    nightCard.style.display = visible ? "block" : "none";
    if (visible) {
      const result = roomData.nightActions?.result;
      nightContent.innerHTML = buildNightResultHTML(result, players);
    }
  }

  // Night "waiting" section
  const nightWaiting = document.getElementById("gm-night-waiting");
  if (nightWaiting) nightWaiting.style.display = phase === "night" ? "block" : "none";

  // 3. Vote tally card
  const voteSection = document.getElementById("gm-vote-section");
  if (voteSection) {
    voteSection.style.display = phase === "voting" ? "block" : "none";
    if (phase === "voting") renderGMVoteTally(roomData);
  }

  // 4. Phase control button visibility
  const phaseCtrl = {
    standby:      "gm-ctrl-standby",
    night:        "gm-ctrl-night",
    "night-done": "gm-ctrl-nightdone",
    day:          "gm-ctrl-day",
    voting:       "gm-ctrl-voting",
  };
  Object.entries(phaseCtrl).forEach(([ph, elemId]) => {
    const el = document.getElementById(elemId);
    if (el) el.style.display = (ph === phase) ? "block" : "none";
  });
}

function buildNightResultHTML(result, players) {
  if (!result) return `<p style="color:var(--text-muted)">ไม่มีข้อมูลคืนนี้</p>`;

  const getName = (id) => id ? escapeHtml(players[id]?.name || "?") : null;

  const wolfName   = getName(result.wolfTarget) || "ไม่ได้โจมตี";
  const doctorName = getName(result.doctorTarget) || "ไม่ได้ปกป้อง";
  const witchHealName = result.witchType === "heal" ? getName(result.witchTarget) : null;
  const witchPoisonName = result.witchType === "poison" ? getName(result.witchTarget) : null;

  let killsHtml = "";
  if (result.killedIds && result.killedIds.length > 0) {
    killsHtml = result.killedIds.map(id => {
      const p = players[id];
      const roleName = p ? getRoleConfig(p.role)?.name : "?";
      return `<div>${getName(id)} ถูกสังหาร (${roleName})</div>`;
    }).join("");
  } else {
    killsHtml = "ไม่มีผู้เสียชีวิต";
  }

  let html = `
    <div class="gm-night-item">
      <span class="gm-night-icon">🐺</span>
      <div>
        <div class="gm-night-label">หมาป่าโจมตี</div>
        <div class="gm-night-value">${wolfName}</div>
      </div>
    </div>
    <div class="gm-night-item">
      <span class="gm-night-icon">💉</span>
      <div>
        <div class="gm-night-label">แพทย์ปกป้อง</div>
        <div class="gm-night-value">${doctorName}</div>
      </div>
    </div>`;

  if (result.witchTarget) {
     html += `
    <div class="gm-night-item">
      <span class="gm-night-icon">🧹</span>
      <div>
        <div class="gm-night-label">แม่มดใช้${result.witchType === 'heal' ? 'ยาชุบ' : 'ยาพิษ'}</div>
        <div class="gm-night-value" style="color:${result.witchType === 'heal' ? '#10b981' : '#ef4444'}">${getName(result.witchTarget)}</div>
      </div>
    </div>`;
  }

  if (result.cupidTarget1 && result.cupidTarget2) {
     html += `
    <div class="gm-night-item">
      <span class="gm-night-icon">💘</span>
      <div>
        <div class="gm-night-label">คิวปิดจับคู่</div>
        <div class="gm-night-value">${getName(result.cupidTarget1)} และ ${getName(result.cupidTarget2)}</div>
      </div>
    </div>`;
  }

  const resultColor = result.killedIds && result.killedIds.length > 0 ? "#ef4444" : "#10b981";

  html += `
    <div class="gm-night-item" style="background:rgba(${result.killedIds && result.killedIds.length > 0 ? "239,68,68" : "16,185,129"},0.06);border-color:rgba(${result.killedIds && result.killedIds.length > 0 ? "239,68,68" : "16,185,129"},0.25)">
      <span class="gm-night-icon">${result.killedIds && result.killedIds.length > 0 ? "💀" : "🛡️"}</span>
      <div>
        <div class="gm-night-label">ผลสรุปคืนนี้</div>
        <div class="gm-night-value" style="color:${resultColor}">${killsHtml}</div>
      </div>
    </div>`;

  return html;
}

function renderGMRoleTable(players, hostId) {
  const table = document.getElementById("gm-role-table");
  if (!table) return;

  const ids     = Object.keys(players);
  const nonGM   = ids.filter(id => id !== hostId);

  table.innerHTML = nonGM.map(id => {
    const p      = players[id];
    const cfg    = getRoleConfig(p.role || "villager");
    const dead   = !p.isAlive;
    return `
      <div class="gm-role-row ${dead ? "gm-status-dead" : ""}">
        <div class="gm-role-avatar" style="background:${cfg.color}22;color:${cfg.color}">${p.name.charAt(0).toUpperCase()}</div>
        <div class="gm-player-name">${escapeHtml(p.name)} ${dead ? "💀" : ""}</div>
        <div class="gm-role-badge" style="border-color:${cfg.color};color:${cfg.color};background:${cfg.color}15">${cfg.icon} ${cfg.name}</div>
      </div>`;
  }).join("");
}

function renderGMVoteTally(roomData) {
  const tally   = document.getElementById("gm-vote-tally");
  if (!tally) return;

  const players = roomData.players || {};
  const alive   = Object.entries(players).filter(([, p]) => p.isAlive && p.role !== "gm");
  const total   = alive.length;
  const voted   = alive.filter(([, p]) => p.vote).length;

  const voteMap = {};
  for (const [, p] of alive) {
    if (p.vote) voteMap[p.vote] = (voteMap[p.vote] || 0) + 1;
  }

  // Sort by vote count
  const sorted = alive
    .filter(([id]) => id !== roomData.hostId)
    .sort(([idA], [idB]) => (voteMap[idB] || 0) - (voteMap[idA] || 0));

  const maxVote = Math.max(1, ...Object.values(voteMap));

  tally.innerHTML = `
    <div class="gm-vote-progress">${voted} / ${total} คนโหวตแล้ว</div>
    ${sorted.map(([id, p]) => {
      const count = voteMap[id] || 0;
      const pct   = Math.round((count / maxVote) * 100);
      return `
        <div class="gm-vote-row">
          <div class="gm-vote-name">${escapeHtml(p.name)}</div>
          <div class="gm-vote-bar-wrap">
            <div class="gm-vote-bar" style="width:${pct}%"></div>
          </div>
          <div class="gm-vote-count">${count} โหวต</div>
        </div>`;
    }).join("")}`;
}

// ─── Player Game View ──────────────────────────────────────────────────────────

function renderPlayerGameView(phase, me, players, roomData) {
  // Role card
  const roleCard = document.getElementById("role-card");
  if (roleCard) {
    roleCard.style.display = "block";
    renderRoleCard(me, players, roomData.hostId);
  }

  // Standby panel
  const standbyPanel = document.getElementById("standby-panel");
  const nightPanel   = document.getElementById("night-panel");
  const dayPanel     = document.getElementById("day-panel");
  const votePanel    = document.getElementById("vote-panel");

  [standbyPanel, nightPanel, dayPanel, votePanel].forEach(el => {
    if (el) el.style.display = "none";
  });

  if (phase === "standby" || phase === "night-done") {
    if (standbyPanel) {
      standbyPanel.style.display = "block";
      const msgEl = document.getElementById("standby-msg");
      if (msgEl) {
        msgEl.textContent = phase === "night-done"
          ? "🌙 รอผู้ดำเนินเกมประกาศผลกลางคืน..."
          : "🎭 รอผู้ดำเนินเกมเริ่มรอบต่อไป...";
      }
    }
  } else if (phase === "night") {
    if (nightPanel) { nightPanel.style.display = "block"; renderNightPanel(me, players); }
  } else if (phase === "day") {
    if (dayPanel) { dayPanel.style.display = "block"; renderDayPanel(me); }
  } else if (phase === "voting") {
    if (votePanel) { votePanel.style.display = "block"; renderVoting(roomData); resetVoteSelection(); }
  }

  // Seer result
  if (me?.role === "seer") updateSeerResult();
}

// ─── Role Card ─────────────────────────────────────────────────────────────────

function renderRoleCard(me, players, hostId) {
  const card = document.getElementById("role-card");
  if (!card || !me?.role) return;

  const cfg    = getRoleConfig(me.role);
  const isDead = !me.isAlive;
  card.className = `glass-card role-card ${isDead ? "role-dead" : ""}`;
  card.style.setProperty("--role-color", cfg.color);

  const iconEl  = document.getElementById("role-icon");
  const nameEl  = document.getElementById("role-name");
  const descEl  = document.getElementById("role-desc");
  const wolvesEl = document.getElementById("wolf-allies");

  if (iconEl) iconEl.textContent = cfg.icon;
  if (nameEl) nameEl.textContent = cfg.name;
  if (descEl) descEl.textContent = cfg.description;

  // Show wolf allies
  if (wolvesEl) {
    if (me.role === "werewolf" || me.role === "minion") {
      const allies = Object.entries(players)
        .filter(([id, p]) => p.role === "werewolf" && id !== STATE.playerId && id !== hostId)
        .map(([, p]) => p.name);
      wolvesEl.classList.toggle("hidden", allies.length === 0);
      if (allies.length) wolvesEl.textContent = `🐺 หมาป่า: ${allies.join(", ")}`;
    } else {
      wolvesEl.classList.add("hidden");
    }
  }
}

// ─── Night Panel ───────────────────────────────────────────────────────────────

function renderNightPanel(me, players) {
  const panel = document.getElementById("night-panel");
  if (!panel) return;

  if (!me?.isAlive) {
    panel.innerHTML = `<div class="night-dead-msg">💀 คุณถูกตัดสิทธิ์แล้ว แต่ยังดูแลคุยได้ในช่อง "ผีสิง"</div>`;
    return;
  }

  const role = me.role;
  const passiveRoles = ["villager", "hunter", "tanner", "minion"];
  if (passiveRoles.includes(role)) {
    panel.innerHTML = `<div class="night-waiting"><div class="moon-anim">🌙</div><p>รอให้คืนผ่านไป...</p><p style="color:var(--text-muted);font-size:0.84rem">คุณไม่ต้องทำอะไรในคืนนี้</p></div>`;
    return;
  }
  
  if (role === "cupid" && STATE.roomData?.dayCount > 1) {
    panel.innerHTML = `<div class="night-waiting"><div class="moon-anim">🌙</div><p>รอให้คืนผ่านไป...</p><p style="color:var(--text-muted);font-size:0.84rem">คิวปิดจับคู่ได้แค่คืนกระแรกคุณไม่ต้องทำอะไรในคืนนี้แล้ว</p></div>`;
    return;
  }

  const actionDone = !!STATE.roomData?.nightActions?.[role + "TargetDone"];
  if (actionDone) {
    panel.innerHTML = `<div class="night-done"><span class="check-anim">✅</span><p>ส่งการกระทำแล้ว รอ GM สรุปคืน...</p></div>`;
    return;
  }

  const actionLabel = { 
    werewolf: "🌙 เลือกเหยื่อของคุณ", 
    seer: "🔮 เลือกคนที่ต้องการตรวจสอบ", 
    doctor: "💉 เลือกคนที่ต้องการปกป้อง",
    witch: "🧹 เลือกชุบชีวิต หรือ สาดพิษ (ใช้ได้คนละ 1 ครั้ง)",
    sorcerer: "🧙‍♂️ เลือกหาตำแหน่งหมอดู",
    cupid: "💘 เลือกคนเพื่อจับคู่ (คนเดียวไปก่อน)"
  }[role] || "เลือกเป้าหมาย";

  const targets = Object.entries(players)
    .filter(([id, p]) => p.isAlive && p.role !== "gm" && id !== STATE.playerId && (role !== "werewolf" || p.role !== "werewolf"));

  panel.innerHTML = `
    <div class="night-action" style="padding:16px">
      <p class="night-action-label">${actionLabel}</p>
      <div class="night-target-grid" id="night-target-grid">
        ${targets.length === 0
          ? `<p style="color:var(--text-muted);font-size:0.84rem;grid-column:1/-1;text-align:center">ไม่มีเป้าหมาย</p>`
          : targets.map(([id, p]) => {
              if (role === "witch") {
                return `
                <div class="night-target-btn witch-card" style="display:flex; flex-direction:column; gap:4px; padding:8px; height:auto; align-items:center;">
                  <div style="text-align:center">
                    <div class="night-avatar" style="margin:0 auto">${p.name.charAt(0).toUpperCase()}</div>
                    <span>${escapeHtml(p.name)}</span>
                  </div>
                  <div style="display:flex; gap:4px; width:100%; margin-top:4px;">
                    <button style="flex:1; padding:4px; font-size:0.7em; background:#10b98120; border:1px solid #10b981; border-radius:4px; color:#10b981; cursor:pointer;" onclick="window._nightAction('${role}', '${id}', this.parentElement.parentElement, 'heal')">ชุบ</button>
                    <button style="flex:1; padding:4px; font-size:0.7em; background:#ef444420; border:1px solid #ef4444; border-radius:4px; color:#ef4444; cursor:pointer;" onclick="window._nightAction('${role}', '${id}', this.parentElement.parentElement, 'poison')">ฆ่า</button>
                  </div>
                </div>`;
              } else {
                return `
                <button class="night-target-btn" onclick="window._nightAction('${role}', '${id}', this)">
                  <div class="night-avatar">${p.name.charAt(0).toUpperCase()}</div>
                  <span>${escapeHtml(p.name)}</span>
                </button>`;
              }
          }).join("")}
      </div>
    </div>`;
}

// ─── Day Panel ─────────────────────────────────────────────────────────────────

function renderDayPanel(me) {
  const panel = document.getElementById("day-panel");
  if (!panel) return;
  if (!me?.isAlive) {
    panel.innerHTML = `<div class="day-dead-msg">💀 คุณถูกตัดสิทธิ์แล้ว ยังดูแลคุยได้ในช่อง "ผีสิง" นะ</div>`;
    return;
  }
  panel.innerHTML = `
    <div class="day-instructions">
      <div class="day-sun-icon">☀️</div>
      <h4>ช่วงกลางวัน — คุยกันและค้นหาหมาป่า!</h4>
      <p>พูดคุยในแชต โหวตเริ่มเมื่อ GM กดเริ่มโหวต</p>
    </div>`;
}

// ─── Seer Result ───────────────────────────────────────────────────────────────

async function updateSeerResult() {
  const result = await getSeerResult();
  const el     = document.getElementById("seer-result");
  if (!el) return;
  if (result) {
    const cfg = getRoleConfig(result.targetRole);
    el.classList.remove("hidden");
    el.textContent = `🔮 ${result.targetName} คือ ${cfg.icon} ${cfg.name}`;
  } else {
    el.classList.add("hidden");
  }
}

// ─── Player Sidebar (player list) ─────────────────────────────────────────────

function renderPlayerSidebar(players, hostId) {
  const list  = document.getElementById("game-player-list");
  if (!list) return;

  const myRole = players[STATE.playerId]?.role || "";

  list.innerHTML = Object.entries(players)
    .filter(([id]) => id !== hostId)  // exclude GM from sidebar
    .map(([id, p]) => {
      const status = p.isAlive ? "alive" : "dead";
      const isMe   = id === STATE.playerId;
      let roleHint = "";
      if (myRole === "werewolf" && p.role === "werewolf" && !isMe) {
        roleHint = `<span class="wolf-hint">🐺</span>`;
      }
      return `
        <div class="player-status player-${status} ${isMe ? "player-me" : ""}">
          <div class="ps-avatar ${status}">${p.name.charAt(0).toUpperCase()}</div>
          <span class="ps-name">${escapeHtml(p.name)} ${isMe ? "<em>(คุณ)</em>" : ""} ${roleHint}</span>
          <span class="ps-status">${p.isAlive ? "" : "💀"}</span>
        </div>`;
    }).join("");
}

// ─── Elimination Banner ────────────────────────────────────────────────────────

export function showEliminationBanner(elim) {
  const banner = document.getElementById("elimination-banner");
  if (!banner) return;
  if (!elim) { banner.classList.add("hidden"); return; }

  let text = "";
  if (elim.reason === "protected")  text = "🛡️ แพทย์ช่วยเหลือ! ไม่มีใครตายในคืนนี้";
  else if (elim.reason === "no-action") text = "🌙 คืนอันเงียบสงัด... ไม่มีใครเสียชีวิต";
  else if (elim.reason === "werewolf")  text = `🐺 ${elim.playerName} ถูกหมาป่าสังหาร! พวกเขาคือ ${getRoleConfig(elim.playerRole).name}`;
  else if (elim.reason === "vote")      text = `🗳️ ${elim.playerName} ถูกโหวตไล่ออก! พวกเขาคือ ${getRoleConfig(elim.playerRole).name}`;
  else if (elim.reason === "tie")       text = "🗳️ โหวตเสมอ! ไม่มีผู้ถูกกำจัดในรอบนี้";
  else if (elim.reason === "skipped")   text = "🗳️ GM ข้ามรอบโหวต";
  else text = elim.playerName ? `${elim.playerName} ถูกกำจัดออก` : "";

  if (text) {
    banner.textContent = text;
    banner.classList.remove("hidden");
    setTimeout(() => banner.classList.add("hidden"), 6000);
  }
}

// ─── Result Screen ─────────────────────────────────────────────────────────────

function renderResult(roomData) {
  const winner  = roomData.winnerTeam;
  const players = roomData.players || {};
  const banner  = document.getElementById("result-banner");

  if (banner) {
    banner.className = `result-banner result-${winner}`;
    const iconEl     = banner.querySelector(".result-icon");
    const titleEl    = banner.querySelector(".result-title");
    const subEl      = banner.querySelector(".result-subtitle");
    if (iconEl)  iconEl.textContent  = winner === "werewolf" ? "🐺" : "🏘️";
    if (titleEl) titleEl.textContent = winner === "werewolf" ? "หมาป่าชนะ!" : "ชาวบ้านชนะ!";
    if (subEl)   subEl.textContent   = winner === "werewolf"
      ? "หมู่บ้านตกอยู่ในความมืด หมาป่าครองคืนแล้ว..."
      : "หมู่บ้านปลอดภัยแล้ว! หมาป่าทุกตัวถูกจับได้หมด";
  }

  const revealList = document.getElementById("result-role-list");
  if (revealList) {
    revealList.innerHTML = Object.entries(players)
      .filter(([id]) => id !== roomData.hostId)   // exclude GM from result list
      .map(([id, p]) => {
        const cfg  = getRoleConfig(p.role);
        const isMe = id === STATE.playerId;
        return `
          <div class="result-player ${p.isAlive ? "result-alive" : "result-dead"}">
            <div class="result-avatar" style="background:${cfg.color}22;border-color:${cfg.color}">${p.name.charAt(0).toUpperCase()}</div>
            <div class="result-player-info">
              <span class="result-player-name">${escapeHtml(p.name)} ${isMe ? "<em>(คุณ)</em>" : ""}</span>
              <span class="result-role" style="color:${cfg.color}">${cfg.icon} ${cfg.name}</span>
            </div>
            <span class="result-alive-badge">${p.isAlive ? "รอดสัตว์" : "💀 ถูกตัดสิทธิ์"}</span>
          </div>`;
      }).join("");
  }

  // Reset lobby button visibility
  const resetBtn = document.getElementById("btn-reset-lobby");
  if (resetBtn) resetBtn.style.display = STATE.isHost ? "" : "none";
}

// ─── Kick Player ───────────────────────────────────────────────────────────────

async function kickPlayer(playerId) {
  if (!STATE.isHost) return;
  await remove(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${playerId}`));
}

// ─── Ready Toggle ──────────────────────────────────────────────────────────────

export async function toggleReady() {
  if (STATE.isHost) return; // GM doesn't toggle ready
  const me  = STATE.roomData?.players?.[STATE.playerId];
  const was = me?.isReady || false;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}`), {
    isReady: !was,
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function showKickedToast(msg) {
  const t = document.createElement("div");
  t.className = "toast-kick";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

function showView(viewName) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  const el = document.getElementById(`view-${viewName}`);
  if (el) el.classList.remove("hidden");
}

function resetState() {
  STATE.roomId     = null;
  STATE.roomData   = null;
  STATE.playerName = "";
  STATE.isHost     = false;
}

function persistSession() {
  try {
    localStorage.setItem("ww_session", JSON.stringify({
      roomId:     STATE.roomId,
      playerId:   STATE.playerId,
      playerName: STATE.playerName,
      isHost:     STATE.isHost,
    }));
  } catch (_) {}
}

// ─── Global Action Handlers ────────────────────────────────────────────────────

window._kickPlayer = kickPlayer;

window._updateDeckCount = async function (role, change) {
  if (!STATE.isHost) return;
  const currentCounts = STATE.roomData?.roleDeckCounts || { werewolf: 1, seer: 1, doctor: 1, villager: 1 };
  const val = (currentCounts[role] || 0) + change;
  if (val < 0) return;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/roleDeckCounts`), {
    [role]: val
  });
};

window._nightAction = async function (role, targetId, btnEl, extraData = null) {
  document.querySelectorAll(".night-target-btn").forEach(b => {
    b.classList.remove("night-selected");
    b.disabled = true;
    const btns = b.querySelectorAll("button");
    if(btns) btns.forEach(bb => bb.disabled = true);
  });
  btnEl.classList.add("night-selected");

  await submitNightAction(role, targetId, extraData);

  const np = document.getElementById("night-panel");
  if (np) np.innerHTML = `<div class="night-done"><span class="check-anim">✅</span><p>ส่งการกระทำแล้ว รอ GM ประกาศ...</p></div>`;
};

export { persistSession, resetState, showView };
