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
  setNightTurn, approveNightAction, rejectNightAction, triggerHunterAbility
} from "./game.js";
import { renderVoting, castVote, resetVoteSelection, resolveVotes, gmSkipVote} from "./voting.js";
import { initChat, setActiveChatTab } from "./chat.js";

let unsubRoom = null;
let lastStatus = null;
let lastPhase  = null;
let lastPlayersStr = null;
let lastRoleDeckCountsStr = null;

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
    roleDeckCounts: {},
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
        document.body.removeAttribute("data-phase");
        const roleCardContainer = document.getElementById("role-card-container");
        if (roleCardContainer) roleCardContainer.classList.remove("highlight-flip");
        // Clear all client-side cached state to prevent stale data between games
        lastPlayersStr = null;
        lastRoleDeckCountsStr = null;
        subscribeToRoom._lastNightActions = null;
        subscribeToRoom._lastNightTurn = null;
        subscribeToRoom._lastHunter = null;
        subscribeToRoom._lastPrivate = null;
        selectedNightTargets = [];
        resetVoteSelection();
        // Clean up stale DOM elements from previous game
        const loverInfo = document.getElementById('lover-info-display');
        if (loverInfo) loverInfo.remove();
        const seerResult = document.getElementById('seer-result');
        if (seerResult) seerResult.classList.add('hidden');
        const elimBanner = document.getElementById('elimination-banner');
        if (elimBanner) elimBanner.classList.add('hidden');
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
      // Data-only update: re-render if any relevant data changed
      const playersStr      = JSON.stringify(roomData.players || {});
      const deckCountsStr   = JSON.stringify(roomData.roleDeckCounts || {});
      const nightActionsStr = JSON.stringify(roomData.nightActions || {});
      const nightTurnStr    = roomData.nightTurn || "";
      const hunterStr       = roomData.hunterPending || "";
      // Private data for current player only (feedback)
      const privateStr      = JSON.stringify(roomData.privateData?.[STATE.playerId] || {});

      const anyChanged =
        playersStr      !== lastPlayersStr ||
        deckCountsStr   !== lastRoleDeckCountsStr ||
        nightActionsStr !== (subscribeToRoom._lastNightActions || "") ||
        nightTurnStr    !== (subscribeToRoom._lastNightTurn || "") ||
        hunterStr       !== (subscribeToRoom._lastHunter || "") ||
        privateStr      !== (subscribeToRoom._lastPrivate || "");

      if (anyChanged) {
        lastPlayersStr = playersStr;
        lastRoleDeckCountsStr = deckCountsStr;
        subscribeToRoom._lastNightActions = nightActionsStr;
        subscribeToRoom._lastNightTurn    = nightTurnStr;
        subscribeToRoom._lastHunter       = hunterStr;
        subscribeToRoom._lastPrivate      = privateStr;

        if (status === "waiting") renderLobby(roomData);
        if (status === "playing") renderGameScreenPartial(roomData);
        if (status === "ended")   renderResult(roomData);
      }
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

  // Player count badge (ONLY non-GM players)
  const countEl = document.getElementById("lobby-player-count");
  if (countEl) {
    countEl.textContent = `${nonGMIds.length} คน`;
  }

  // GM section
  const gmPlayer = players[hostId];
  const gmIsMe   = hostId === STATE.playerId;
  const gmHtml   = gmPlayer ? `
    <div class="lobby-player lobby-player-gm ${gmIsMe ? "lobby-player-me" : ""}" style="border-color: var(--day-gold);">
      <div class="lobby-player-left">
        <div class="lobby-avatar lobby-avatar-gm" style="background: var(--day-gold);">🎭</div>
        <div class="lobby-info">
          <span class="lobby-name">${escapeHtml(gmPlayer.name)} ${gmIsMe ? "<span class='you-badge' style='background:var(--day-gold);'>คุณ</span>" : ""}</span>
          <span class="gm-badge-label" style="color: var(--day-gold);">🎭 ผู้ดำเนินเกม (GM)</span>
        </div>
      </div>
      <div class="lobby-player-right">
        <span class="ready-badge ready-gm" style="background: rgba(245, 158, 11, 0.1); color: var(--day-gold); border-color: rgba(245, 158, 11, 0.3);">GM</span>
      </div>
    </div>` : "";

  const gmSectionEl = document.getElementById("lobby-gm-section");
  if (gmSectionEl) gmSectionEl.innerHTML = gmHtml;

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
  if (listEl) listEl.innerHTML = playerRows;

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
  const counts = roomData.roleDeckCounts || {};
  const totalDeck = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  const targetPlayers = nonGMIds.length;

  const countSel = document.getElementById("deck-count-selected");
  const countReq = document.getElementById("deck-count-required");
  if (countSel) countSel.textContent = totalDeck;
  if (countReq) countReq.textContent = targetPlayers;

  // Render GM Deck Controls
  if (STATE.isHost) {
    const categories = {
      villager: "ฝ่ายชาวบ้าน",
      werewolf: "ฝ่ายหมาป่า",
      independent: "อิสระ/อื่นๆ"
    };
    
    let deckSetupHtml = `<div style="display:flex; flex-direction:column; gap:16px;">`;
    
    for (const [teamKey, teamName] of Object.entries(categories)) {
      deckSetupHtml += `<div><h5 style="color:var(--text-muted); margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:4px;">${teamName}</h5><div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:8px;">`;
      
      const teamRoles = Object.keys(ROLES).filter(r => ROLES[r].team === teamKey);
      teamRoles.forEach(rKey => {
        const info = ROLES[rKey];
        const count = counts[rKey] || 0;
        deckSetupHtml += `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; background:rgba(0,0,0,0.15); border-radius:6px; border-left: 3px solid ${info.color}80;">
            <div style="display:flex; align-items:center; overflow:hidden;" title="${info.description}">
              <span style="font-size:1.1em; margin-right:6px;">${info.icon}</span>
              <span style="color:${info.color}; font-weight:600; font-size:0.9em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${info.name}</span>
            </div>
            <div style="display:flex; align-items:center; gap:4px;">
              <button class="btn btn-ghost" style="padding:2px 8px; font-size:1.1em;" onclick="window._updateDeckCount('${rKey}', -1)">-</button>
              <span style="font-weight:bold; font-size:1em; width:16px; text-align:center">${count}</span>
              <button class="btn btn-ghost" style="padding:2px 8px; font-size:1.1em;" onclick="window._updateDeckCount('${rKey}', 1)">+</button>
            </div>
          </div>`;
      });
      deckSetupHtml += `</div></div>`;
    }
    deckSetupHtml += `</div>`;
    
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
    if (totalDeck > 0) {
      pubContainer.innerHTML = pubDeckHtml;
    } else {
      pubContainer.innerHTML = STATE.isHost 
        ? `<div class="text-center w-100" style="color: var(--day-gold); padding: 20px; font-weight: 500;">🎮 กรุณาจัดเตรียมบทบาทที่ส่วน "ตัวจัดการการ์ดเกม" ด้านบน</div>`
        : `<div class="text-center w-100" style="color: rgba(255,255,255,0.5); padding: 20px;">รอ GM จัดไพ่...</div>`;
    }
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

  // Set phase for ambient sky transitions
  document.body.setAttribute("data-phase", phase);
}

// ─── GM Panel Toggle ───────────────────────────────────────────────────────────

function showGMPanel() {
  document.getElementById("gm-main-panel")?.style.setProperty("display", "flex");
  document.getElementById("gm-main-panel")?.style.setProperty("flex-direction", "column");
  // Hide all player panels
  ["role-card-container", "night-panel", "day-panel", "vote-panel", "standby-panel"].forEach(id => {
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
      const actions = roomData.nightActions || {};
      nightContent.innerHTML = buildNightResultHTML(actions, players);
    }
  }

  // 3. Night Logic Control (visible when phase=night or night-done)
  const nightCtrl = document.getElementById("gm-night-control");
  if (nightCtrl) {
    const isNight = phase === "night" || phase === "night-done";
    nightCtrl.style.display = isNight ? "block" : "none";
    if (isNight) renderGMNightControl(roomData);
  }

  // 4. Vote tally card (show only during voting phase)
  const voteSection = document.getElementById("gm-vote-section");
  if (voteSection) {
    const isVoting = phase === "voting";
    voteSection.style.display = isVoting ? "block" : "none";
    if (isVoting) renderGMVoteTally(roomData);
  }

  // 5. Phase control button visibility
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

  // 6. Hunter pending notification
  let hunterNotify = document.getElementById("gm-hunter-notify");
  if (!hunterNotify) {
    hunterNotify = document.createElement("div");
    hunterNotify.id = "gm-hunter-notify";
    hunterNotify.className = "glass-card gm-card";
    hunterNotify.style.cssText = "border-color:rgba(234,88,12,0.4);background:rgba(234,88,12,0.06);";
    const mainPanel = document.getElementById("gm-main-panel");
    // Insert after gm-night-control
    const nightCtrlEl = document.getElementById("gm-night-control");
    if (nightCtrlEl && nightCtrlEl.nextSibling) mainPanel?.insertBefore(hunterNotify, nightCtrlEl.nextSibling);
    else mainPanel?.appendChild(hunterNotify);
  }
  const hunterPendingId = roomData.hunterPending;
  if (hunterPendingId) {
    const hunterPlayer = players[hunterPendingId];
    const pending = roomData.nightActions?.pending;
    const isPendingHunter = pending?.role === "hunter";
    hunterNotify.style.display = "block";
    hunterNotify.innerHTML = `
      <div class="gm-card-title"><span>🔫</span> พรานป่ากำลังใช้พลัง!</div>
      <p style="color:#f87171;margin:8px 0"><b>${escapeHtml(hunterPlayer?.name || "?")}</b> ถูกฆ่าแล้ว — กำลังเล็งเป้าหมายก่อนตาย</p>
      ${ isPendingHunter ? `
        <div style="margin-top:10px;padding:10px;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.3);border-radius:8px">
          <p style="color:orange;font-weight:700;margin-bottom:8px">⚖️ พรานป่าเลือกยิง:</p>
          <div style="font-size:0.95em;margin-bottom:10px">เป้าหมาย: <b style="color:#fca5a5">${escapeHtml(players[pending.targetId]?.name || pending.targetId)}</b></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" style="flex:1" onclick="window._approveAction()">✅ อนุมัติ (ยิงเลย)</button>
            <button class="btn btn-ghost btn-sm" style="flex:1;border:1px solid rgba(255,255,255,0.2)" onclick="window._rejectAction()">❌ ให้เลือกใหม่</button>
          </div>
        </div>` : `<p style="color:var(--text-muted);font-size:0.85em;margin-top:8px">⏳ รอผู้เล่นส่งเป้าหมายที่จะยิง...</p>`}
    `;
  } else {
    hunterNotify.style.display = "none";
  }
}

function buildNightResultHTML(actions, players) {
  if (!actions || Object.keys(actions).filter(k => k.endsWith('Target')).length === 0) {
    return `<p style="color:var(--text-muted)">ไม่มีกิจกรรมพิเศษในคืนนี้ หรือทุกคนเลือกข้ามสิทธิ์</p>`;
  }

  const getName = (id) => {
    if (!id || id === 'skip') return null;
    return escapeHtml(players[id]?.name || "?");
  };

  let html = `<div style="display:flex; flex-direction:column; gap:8px;">`;
  
  Object.keys(ROLES).forEach(role => {
    const targetId = actions[`${role}Target`];
    const extra = actions[`${role}Extra`];
    if (targetId && targetId !== 'skip') {
      const cfg = ROLES[role];
      const targetList = targetId.split(',').map(tid => getName(tid)).filter(n => n).join(" และ ");
      
      let extraStr = "";
      if (role === 'witch') {
        extraStr = ` <i>(ใช้ ${extra === 'heal' ? 'ยาชุบ' : 'ยาพิษ'})</i>`;
      }
      
      html += `
        <div class="gm-night-item" style="display:flex; align-items:center; gap:12px; background:rgba(255,255,255,0.05); padding:8px 12px; border-radius:8px; border-left:3px solid ${cfg.color}; margin-bottom:4px;">
          <span style="font-size:1.5em">${cfg.icon}</span>
          <div>
            <div style="font-size:0.85em; color:var(--text-muted);">${cfg.name}</div>
            <div style="font-weight:600; color:${cfg.color}">${targetList}${extraStr}</div>
          </div>
        </div>
      `;
    }
  });

  html += `
    <div style="margin-top:16px; padding:12px; background:rgba(239,68,68,0.1); border-radius:8px; border: 1px solid rgba(239,68,68,0.3);">
      <h5 style="color:#ef4444; margin-bottom:8px; font-size:1em;">⚠️ การจัดการผู้ตาย (แบบแมนนวล)</h5>
      <p style="font-size:0.8em; color:rgba(255,255,255,0.8); line-height:1.4;">
        ระบบจะไม่หักลบคนตายให้อัตโนมัติในโหมด Extreme GM-Assisted ตอนนี้<br>
        กรุณาอ่านรายงานด้านบน สรุปผลว่าใครตาย แล้วใช้ปุ่ม <b>"ฆ่า" / "ชุบ"</b> ในรายชื่อข้างล่างจัดการสถานะให้เรียบร้อย ก่อนกดเริ่มวันใหม่!
      </p>
    </div></div>`;

  return html;
}

function renderGMRoleTable(players, hostId) {
  const table = document.getElementById("gm-role-table");
  if (!table) return;

  const ids   = Object.keys(players);
  const nonGM = ids.filter(id => id !== hostId);
  const lovers = STATE.roomData?.lovers;

  // Count votes for tooltip
  const voteMap = {};
  for (const p of Object.values(players)) {
    if (p.vote) voteMap[p.vote] = (voteMap[p.vote] || 0) + 1;
  }

  table.innerHTML = nonGM.map(id => {
    const p    = players[id];
    const cfg  = getRoleConfig(p.role || "villager");
    const dead = !p.isAlive;
    const votes = voteMap[id] ? `<span style="background:rgba(239,68,68,0.2);color:#f87171;padding:2px 6px;border-radius:4px;font-size:0.75em;margin-left:4px">${voteMap[id]}🗳️</span>` : "";
    
    // Status badges
    const status = p.status || {};
    let statusHtml = "";
    if (status.silenced) statusHtml += `<span class="status-badge status-silenced" style="margin-left:4px">🤐</span>`;
    if (status.banned) statusHtml += `<span class="status-badge status-banned" style="margin-left:4px">🚫</span>`;
    if (status.lover) {
      const loverName = players[status.lover]?.name || "?";
      statusHtml += `<span class="status-badge status-lover" style="margin-left:4px" title="คู่รัก: ${escapeHtml(loverName)}">💘</span>`;
    }
    
    return `
      <div class="gm-role-row ${dead ? "gm-status-dead" : ""}">
        <div class="gm-role-avatar" style="background:${cfg.color}22;color:${cfg.color}">${p.name.charAt(0).toUpperCase()}</div>
        <div class="gm-player-name">${escapeHtml(p.name)}${statusHtml}${votes} ${dead ? "💀" : ""}</div>
        <div class="gm-role-badge" style="border-color:${cfg.color};color:${cfg.color};background:${cfg.color}15">${cfg.icon} ${cfg.name}</div>
        <button class="btn ${dead ? 'btn-primary' : 'btn-danger'} btn-sm" style="padding:3px 10px; font-size:0.78em; margin-left:8px;" onclick="window._togglePlayerAlive('${id}', ${dead})">${dead ? "ชุบ" : "ฆ่า"}</button>
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

// ─── GM Night Turn Control ───────────────────────────────────────────────────

function renderGMNightControl(roomData) {
  const turnListContainer = document.getElementById("gm-night-turn-list");
  const pendingContainer  = document.getElementById("gm-pending-action");
  const pendingContent    = document.getElementById("gm-pending-content");
  const currentTurnEl     = document.getElementById("gm-current-turn");
  
  if (!turnListContainer || !pendingContainer || !pendingContent || !currentTurnEl) return;

  const players = roomData.players || {};
  const currentTurn = roomData.nightTurn;
  const actions = roomData.nightActions || {};
  const dayCount = roomData.dayCount || 1;

  currentTurnEl.textContent = currentTurn ? ROLES[currentTurn]?.name || currentTurn : "ยังไม่มีการเรียก";

  // 1. Identify active nightly roles (alive players)
  const activeRoles = new Set();
  Object.values(players).forEach(p => {
    if (p.isAlive && p.role !== "gm") {
      const cfg = ROLES[p.role];
      if (cfg && (cfg.actionPhase === "nightly" || (cfg.actionPhase === "firstNight" && dayCount === 1))) {
        activeRoles.add(p.role);
      }
    }
  });

  // 2. Render turn buttons
  turnListContainer.innerHTML = Array.from(activeRoles).map(roleKey => {
    const cfg = ROLES[roleKey];
    const isCurrent = currentTurn === roleKey;
    const isDone = !!actions[roleKey + "TargetDone"];
    
    return `
      <button class="btn ${isCurrent ? "btn-primary" : "btn-ghost"}" 
              style="padding:6px 12px; font-size:0.85rem; border:1px solid ${isCurrent ? "transparent" : "rgba(255,255,255,0.2)"}"
              onclick="window._setNightTurn('${roleKey}')"
              ${isDone ? "disabled" : ""}>
        ${cfg.icon} เรียก ${cfg.name} ${isDone ? "✅" : ""}
      </button>
    `;
  }).join("");

  // 3. Render Pending Action
  const pending = actions.pending;
  if (pending) {
    const roleCfg = ROLES[pending.role];
    const targetPlayer = players[pending.targetId];
    const targetName = pending.targetId === "skip" ? "ไม่เลือกใคร (ข้าม)" : (targetPlayer ? targetPlayer.name : "???");
    
    pendingContainer.classList.remove("hidden");
    let actionInfo = `<b>${roleCfg.icon} ${roleCfg.name}</b> เลือกเป้าหมาย: <b style="color:#6ee7b7">${targetName}</b>`;
    if (pending.extraData) actionInfo += ` (${pending.extraData})`;
    pendingContent.innerHTML = actionInfo;
  } else {
    pendingContainer.classList.add("hidden");
  }
}

// ─── Player Game View ──────────────────────────────────────────────────────────

function renderPlayerGameView(phase, me, players, roomData) {
  // Role card
  const roleCardContainer = document.getElementById("role-card-container");
  if (roleCardContainer) {
    roleCardContainer.style.display = "block";
    renderRoleCard(me, players, roomData.hostId);
    if (!roleCardContainer.classList.contains("highlight-flip")) {
      roleCardContainer.classList.remove("highlight-flip");
      setTimeout(() => requestAnimationFrame(() => roleCardContainer.classList.add("highlight-flip")), 500);
    }
  }

  const standbyPanel = document.getElementById("standby-panel");
  const nightPanel   = document.getElementById("night-panel");
  const dayPanel     = document.getElementById("day-panel");
  const votePanel    = document.getElementById("vote-panel");

  [standbyPanel, nightPanel, dayPanel, votePanel].forEach(el => { if (el) el.style.display = "none"; });

  // ── Hunter death-ability override ──────────────────────────────────────────
  const hunterPending = STATE.roomData?.hunterPending;
  if (hunterPending && hunterPending === STATE.playerId && !me?.isAlive) {
    if (nightPanel) {
      nightPanel.style.display = "block";
      const hasPendingShot = STATE.roomData?.nightActions?.pending?.submittedBy === STATE.playerId
        && STATE.roomData?.nightActions?.pending?.role === "hunter";
      if (hasPendingShot) {
        nightPanel.innerHTML = `<div class="night-done"><span class="moon-anim" style="font-size:2em">⏳</span><p style="font-weight:700;color:#fb923c">รอ GM อนุมัติ...</p><p style="color:var(--text-muted);font-size:0.85em">GM กำลังพิจารณาเป้าหมายที่คุณเลือก</p></div>`;
      } else {
        renderHunterPanel(nightPanel, players, roomData.hostId);
      }
    }
    if (me?.role === "seer") updateSeerResult();
    return;
  }
  // ──────────────────────────────────────────────────────────────────────────

  if (phase === "standby" || phase === "night-done") {
    if (standbyPanel) {
      standbyPanel.style.display = "block";
      const msgEl = document.getElementById("standby-msg");
      if (msgEl) msgEl.textContent = phase === "night-done"
        ? "🌙 รอผู้ดำเนินเกมประกาศผลกลางคืน..."
        : "🎭 รอผู้ดำเนินเกมเริ่มรอบต่อไป...";
    }
  } else if (phase === "night") {
    if (nightPanel) { nightPanel.style.display = "block"; renderNightPanel(me, players); }
  } else if (phase === "day") {
    if (dayPanel) { dayPanel.style.display = "block"; renderDayPanel(me); }
  } else if (phase === "voting") {
    if (votePanel) { votePanel.style.display = "block"; renderVoting(roomData); resetVoteSelection(); }
  }

  if (me?.role === "seer") updateSeerResult();
}

// ─── Role Card ─────────────────────────────────────────────────────────────────

function renderRoleCard(me, players, hostId) {
  const card = document.getElementById("role-card");
  if (!card) return;

  // Fallback to villager IF the game has started but role is missing
  // Otherwise show a loading state
  const roleKey = me?.role || "villager";
  const cfg     = getRoleConfig(roleKey);
  const isDead  = me ? !me.isAlive : false;
  
  card.className = `glass-card role-card ${isDead ? "role-dead" : ""}`;
  card.style.setProperty("--role-color", cfg.color);

  const iconEl   = document.getElementById("role-icon");
  const nameEl   = document.getElementById("role-name");
  const descEl   = document.getElementById("role-desc");
  const wolvesEl = document.getElementById("wolf-allies");

  if (iconEl) iconEl.textContent = cfg.icon;
  if (nameEl) {
    nameEl.textContent = me?.role ? cfg.name : "กำลังเตรียมบทบาท...";
  }
  if (descEl) {
    descEl.textContent = me?.role ? cfg.description : "กรุณารอสักครู่ กำลังแจกแจงบทบาทของคุณ";
  }

  // Additional Intelligence
  if (wolvesEl) {
    wolvesEl.classList.add("hidden");
    const role = me.role;
    let allies = [];
    let allyLabel = "";
    
    if (["werewolf", "alpha_wolf", "dire_wolf", "lone_wolf", "mystic_wolf", "wolf_cub", "wolf_man", "minion", "idiot"].includes(role)) {
      allies = Object.entries(players)
        .filter(([id, p]) => ["werewolf", "alpha_wolf", "dire_wolf", "lone_wolf", "mystic_wolf", "wolf_cub", "wolf_man"].includes(p.role) && id !== STATE.playerId && id !== hostId)
        .map(([, p]) => p.name);
      
      if (allies.length) {
        wolvesEl.classList.remove("hidden");
        allyLabel = "🐺 หมาป่าที่อยู่ในฝูง";
        if (role === "minion") allyLabel = "🐺 หมาป่าที่คุณต้องปกป้อง";
        if (role === "idiot") allyLabel = "🐺 ฝูงหมาป่าในคืนแรก";
        wolvesEl.textContent = `${allyLabel}: ${allies.join(", ")}`;
      }
    } else if (role === "mason") {
      allies = Object.entries(players)
        .filter(([id, p]) => p.role === "mason" && id !== STATE.playerId && id !== hostId)
        .map(([, p]) => p.name);
      if (allies.length) {
        wolvesEl.classList.remove("hidden");
        wolvesEl.innerHTML = `🧱 เพื่อนพรรคเดียวกัน: <b>${allies.join(", ")}</b>`;
      }
    } else if (role === "beholder") {
      allies = Object.entries(players)
        .filter(([id, p]) => p.role === "seer" && id !== STATE.playerId && id !== hostId)
        .map(([, p]) => p.name);
      if (allies.length) {
        wolvesEl.classList.remove("hidden");
        wolvesEl.innerHTML = `🔮 หมอดูตัวจริงคือ: <b>${allies.join(", ")}</b>`;
      }
    }
    
    // Show lover info on role card
    const myStatus = me?.status || {};
    if (myStatus.lover) {
      const loverPlayer = players[myStatus.lover];
      if (loverPlayer) {
        const loverDiv = document.createElement('div');
        loverDiv.className = 'wolf-allies';
        loverDiv.style.cssText = 'margin-top:10px;background:rgba(244,63,94,0.1);border:1px solid rgba(244,63,94,0.25);color:#fda4af;';
        loverDiv.innerHTML = `💘 คู่รักของคุณ: <b>${escapeHtml(loverPlayer.name)}</b> <span style="font-size:0.78em;color:var(--text-muted)">— หากคนใดคนหนึ่งตาย อีกคนจะตายตาม</span>`;
        // Insert after wolf-allies if it exists, or after the card header
        const cardFront = document.querySelector('.role-card-front');
        if (cardFront && !document.getElementById('lover-info-display')) {
          loverDiv.id = 'lover-info-display';
          cardFront.appendChild(loverDiv);
        } else if (document.getElementById('lover-info-display')) {
          document.getElementById('lover-info-display').innerHTML = loverDiv.innerHTML;
        }
      }
    }
  }
}

// ─── Night Panel ───────────────────────────────────────────────────────────────

function renderNightPanel(me, players) {
  const panel = document.getElementById("night-panel");
  if (!panel) return;

  if (!me?.isAlive) {
    if (me?.role === "ghost" && STATE.roomData?.dayCount > 1) {
      panel.innerHTML = `<div class="night-waiting" style="padding:16px"><div class="moon-anim">🌙</div><p>ส่งข้อความใบ้ 1 ตัวอักษรให้เพื่อนตอนเช้า</p><p style="font-size:0.8em;color:gray">GM ให้แจ้งข้อความในกล่องแชตได้ 1 อักษรครับ</p></div>`;
      return;
    }
    panel.innerHTML = `<div class="night-dead-msg">💀 คุณถูกตัดสิทธิ์แล้ว แต่ยังดูแลคุยได้ในช่อง "ผีสิง"</div>`;
    return;
  }

  const role = me.role;
  const cfg = ROLES[role];
  
  if (!cfg || cfg.actionPhase === "none" || (cfg.actionPhase === "firstNight" && STATE.roomData?.dayCount > 1)) {
    panel.innerHTML = `<div class="night-waiting"><div class="moon-anim">🌙</div><p>รอให้คืนผ่านไป...</p><p style="color:var(--text-muted);font-size:0.84rem">คุณสมบัติแฝง หรือ คุณไม่ต้องทำอะไรในคืนนี้</p></div>`;
    return;
  }

  const actionDone = !!STATE.roomData?.nightActions?.[role + "TargetDone"];
  const isTurn     = STATE.roomData?.nightTurn === role;

  if (actionDone) {
    // Show role-specific feedback if GM has approved
    const feedback = STATE.roomData?.privateData?.[STATE.playerId]?.nightFeedback;
    const dc = STATE.roomData?.dayCount || 1;
    if (feedback && feedback.dayCount === dc) {
      panel.innerHTML = buildNightFeedbackHTML(feedback);
    } else {
      // GM approved but feedback not yet written — show pending
      panel.innerHTML = `<div class="night-done"><span class="check-anim">✅</span><p>GM อนุมัติแล้ว!</p><p style="color:var(--text-muted);font-size:0.85em">รอประกาศผลตอนเช้า</p></div>`;
    }
    return;
  }

  if (!isTurn) {
    panel.innerHTML = `
      <div class="night-waiting">
        <div class="moon-anim">🌙</div>
        <p>คุณ (${cfg.name}) ยังไม่มีคิวใช้ความสามารถ</p>
        <p style="color:var(--day-gold);font-size:0.84rem;font-weight:700">หลับตารอ GM เรียกชื่อคุณครับ...</p>
      </div>`;
    return;
  }

  const hasPending = STATE.roomData?.nightActions?.pending?.submittedBy === STATE.playerId;
  if (hasPending) {
    panel.innerHTML = `<div class="night-done"><span class="moon-anim">⏳</span><p>รอ GM อนุมัติการกระทำของคุณ...</p></div>`;
    return;
  }

  const actionLabel = `ลืมตามาปฏิบัติหน้าของคุณ (${cfg.name})`;

  const targets = Object.entries(players)
    .filter(([id, p]) => {
      const isSelf = id === STATE.playerId;
      const isGM   = p.role === "gm";
      const isAlive = p.isAlive;
      
      if (!isAlive || isGM) return false;
      
      // Allow self-target for Bodyguard (ผู้คุ้มกัน)
      if (role === "bodyguard" && isSelf) return true;
      
      // Standard target restriction: not self
      if (isSelf) return false;

      // Werewolf team standard targeting restriction (not teammates)
      const isWolfTeam = ["werewolf", "alpha_wolf", "dire_wolf", "lone_wolf", "mystic_wolf", "wolf_cub", "wolf_man"].includes(p.role);
      if (cfg.team === "werewolf" && isWolfTeam) return false;

      return true;
    });

  let skipBtn = `<button class="btn btn-ghost mt-3 w-100" style="color:#d1d5db; border: 1px solid rgba(255,255,255,0.3)" onclick="window._nightAction('${role}', 'skip', this, 'skip')">ข้าม (ไม่ใช้พลัง)</button>`;

  panel.innerHTML = `
    <div class="night-action" style="padding:16px">
      <p class="night-action-label">${cfg.icon} ${actionLabel}</p>
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
                    <button style="flex:1; padding:4px; font-size:0.7em; background:#10b98120; border:1px solid #10b981; border-radius:4px; color:#10b981; cursor:pointer;" onclick="window._nightAction('${role}', '${id}', this, 'heal')">ชุบ</button>
                    <button style="flex:1; padding:4px; font-size:0.7em; background:#ef444420; border:1px solid #ef4444; border-radius:4px; color:#ef4444; cursor:pointer;" onclick="window._nightAction('${role}', '${id}', this, 'poison')">ฆ่า</button>
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
      ${skipBtn}
    </div>`;
}

// ─── Night Feedback HTML (role-specific result shown to player after GM approves) ──

function buildNightFeedbackHTML(feedback) {
  const T    = feedback.type;
  const name = feedback.targetName
    ? `<b style="color:white">${escapeHtml(feedback.targetName)}</b>`
    : "";

  const card = (icon, title, titleColor, body, borderColor, bgColor) =>
    `<div class="night-feedback" style="border-color:${borderColor};background:${bgColor}">
      <div class="nf-icon">${icon}</div>
      <p class="nf-title" style="color:${titleColor}">${title}</p>
      ${body}
    </div>`;

  if (T === "skipped") {
    return card("⏭️", "ข้ามการกระทำ", "#9ca3af",
      `<p class="nf-sub">รอ GM ประกาศผลและเริ่มวันใหม่</p>`,
      "rgba(107,114,128,0.3)", "rgba(107,114,128,0.06)");
  }

  if (T === "wolf_kill") {
    return card("🐺", "ยืนยันเป้าหมาย!", "#ef4444",
      `<p style="margin:4px 0">${name}</p><p class="nf-sub">จะถูกกัดคืนนี้ — รอ GM ประกาศผลตอนเช้า</p>`,
      "rgba(239,68,68,0.3)", "rgba(239,68,68,0.08)");
  }

  if (T === "seer" || T === "inspect") {
    const isWolf  = feedback.isWolf;
    const verdict = isWolf ? "🐺 หมาป่า!" : "✅ ชาวบ้าน";
    const color   = isWolf ? "#ef4444" : "#10b981";
    const icon2   = T === "inspect" ? "👁️🐺" : "🔮";
    return card(icon2, "ผลการส่อง", color,
      `<p style="margin:4px 0">${name}</p><p style="font-size:1.4em;font-weight:800;color:${color};margin:6px 0">${verdict}</p>`,
      `${color}40`, `${color}10`);
  }

  if (T === "sorceress") {
    const isSeer  = feedback.isSeer;
    const verdict = isSeer ? "🔮 ใช่! นี่คือหมอดู!" : "❌ ไม่ใช่หมอดู";
    const color   = isSeer ? "#a78bfa" : "#6b7280";
    return card("🔮🐺", "ผลการหาหมอดู", color,
      `<p style="margin:4px 0">${name}</p><p style="font-size:1.15em;font-weight:800;color:${color};margin:6px 0">${verdict}</p>`,
      `${color}40`, `${color}10`);
  }

  if (T === "aura") {
    const hasS  = feedback.hasSpecial;
    const verdict = hasS ? "✨ มีบทบาทพิเศษ" : "👤 ชาวบ้านธรรมดา";
    const color   = hasS ? "#d946ef" : "#6b7280";
    return card("✨", "ผลออร่า", color,
      `<p style="margin:4px 0">${name}</p><p style="font-size:1.15em;font-weight:800;color:${color};margin:6px 0">${verdict}</p>`,
      `${color}40`, `${color}10`);
  }

  if (T === "pi") {
    const isWolf  = feedback.isWolf;
    const verdict = isWolf ? "🐺 มีหมาป่าในบริเวณนี้!" : "✅ ไม่พบหมาป่า";
    const color   = isWolf ? "#ef4444" : "#10b981";
    return card("🕵️", "ผลสืบสวน", color,
      `<p style="margin:4px 0">${name} และคนข้างเคียง</p><p style="font-size:1.15em;font-weight:800;color:${color};margin:6px 0">${verdict}</p>`,
      `${color}40`, `${color}10`);
  }

  if (T === "guard") {
    return card("🛡️", "ปกป้องสำเร็จ!", "#10b981",
      `<p style="margin:4px 0">${name}</p><p class="nf-sub">ปลอดภัยคืนนี้แล้ว!</p>`,
      "rgba(16,185,129,0.3)", "rgba(16,185,129,0.08)");
  }

  if (T === "witch") {
    const isHeal = feedback.action === "ชุบชีวิต";
    const color  = isHeal ? "#10b981" : "#ef4444";
    const icon2  = isHeal ? "🧪" : "☠️";
    return card(icon2, `${feedback.action} สำเร็จ!`, color,
      `<p style="margin:4px 0">${name}</p><p class="nf-sub">รอ GM ประกาศผลตอนเช้า</p>`,
      `${color}40`, `${color}10`);
  }

  if (T === "ban") {
    return card("🚫", "แบนสำเร็จ!", "#9ca3af",
      `<p style="margin:4px 0">${name}</p><p class="nf-sub">จะไม่มีสิทธิ์โหวตพรุ่งนี้</p>`,
      "rgba(107,114,128,0.3)", "rgba(107,114,128,0.06)");
  }

  if (T === "silence") {
    return card("🤐", "ปิดปากสำเร็จ!", "#a78bfa",
      `<p style="margin:4px 0">${name}</p><p class="nf-sub">พรุ่งนี้พวกเขาจะพูดหรือโหวตไม่ได้</p>`,
      "rgba(139,92,246,0.3)", "rgba(139,92,246,0.06)");
  }

  if (T === "kill_confirmed") {
    return card("🔪", "สังหารสำเร็จ!", "#ef4444",
      `<p style="margin:4px 0">${name}</p><p class="nf-sub">รอ GM ประกาศผลตอนเช้า</p>`,
      "rgba(239,68,68,0.3)", "rgba(239,68,68,0.08)");
  }

  if (T === "hunter_shot") {
    return card("🔫", "ยิงสำเร็จ!", "#f97316",
      `<p style="margin:4px 0">${name}</p><p class="nf-sub">จะตายตามคุณไปด้วย — GM ดำเนินการต่อ</p>`,
      "rgba(234,88,12,0.3)", "rgba(234,88,12,0.08)");
  }

  if (T === "cult_recruit") {
    return card("🛐", "ดึงเข้าลัทธิสำเร็จ!", "#a78bfa",
      `<p style="margin:4px 0">${name}</p><p class="nf-sub">ตอนนี้อยู่ในลัทธิของคุณแล้ว</p>`,
      "rgba(139,92,246,0.3)", "rgba(139,92,246,0.06)");
  }

  if (T === "action_confirmed") {
    return card("✅", "GM อนุมัติแล้ว!", "#10b981",
      `${name ? `<p style="margin:4px 0">${name}</p>` : ""}<p class="nf-sub">รอ GM ประกาศผลตอนเช้า</p>`,
      "rgba(16,185,129,0.3)", "rgba(16,185,129,0.08)");
  }

  if (T === "cupid_pair") {
    return card("💘", "จับคู่รักสำเร็จ!", "#f43f5e",
      `<p style="margin:4px 0">${name}</p><p class="nf-sub">ทั้งสองคนกลายเป็นคู่รักกันแล้ว ❤️ หากคนใดคนหนึ่งตาย อีกคนจะตายตามไปด้วย!</p>`,
      "rgba(244,63,94,0.3)", "rgba(244,63,94,0.08)");
  }

  // default fallback
  return `<div class="night-done"><span class="check-anim">✅</span><p>GM อนุมัติแล้ว!</p><p class="nf-sub">รอประกาศตอนเช้า</p></div>`;
}

// ─── Hunter Death Panel ────────────────────────────────────────────────────────

function renderHunterPanel(panel, players, hostId) {
  const targets = Object.entries(players)
    .filter(([id, p]) => p.isAlive && id !== STATE.playerId && p.role !== "gm" && id !== hostId);

  panel.innerHTML = `
    <div class="night-action" style="padding:16px">
      <div style="text-align:center;margin-bottom:12px">
        <div style="font-size:2.5em;margin-bottom:4px">🔫</div>
        <p class="night-action-label" style="color:#f97316">ก่อนตาย คุณยิงผู้เล่น 1 คนได้!</p>
        <p style="color:var(--text-muted);font-size:0.84rem;margin-top:4px">เลือกเป้าหมายที่จะพาไปด้วย</p>
      </div>
      <div class="night-target-grid">
        ${targets.length === 0
          ? `<p style="color:var(--text-muted);font-size:0.84rem;grid-column:1/-1;text-align:center">ไม่มีเป้าหมายที่มีชีวิต</p>`
          : targets.map(([id, p]) =>
              `<button class="night-target-btn" onclick="window._nightAction('hunter','${id}',this)">
                <div class="night-avatar">${p.name.charAt(0).toUpperCase()}</div>
                <span>${escapeHtml(p.name)}</span>
              </button>`
            ).join("")}
      </div>
      <button class="btn btn-ghost mt-3 w-100" style="color:#d1d5db;border:1px solid rgba(255,255,255,0.3)"
        onclick="window._nightAction('hunter','skip',this,'skip')">ไม่ยิงใคร — ยอมรับชะตา</button>
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
  
  const isSilenced = me.status?.silenced;
  const isBanned = me.status?.banned;
  
  if (isSilenced) {
    panel.innerHTML = `
      <div class="day-silenced-msg">
        <div class="silenced-icon">🤐</div>
        <h4>คุณถูกปิดปากโดยผู้ร่ายเวทย์!</h4>
        <p>คุณไม่สามารถพูดหรือโหวตได้ในวันนี้ นั่งฟังและรอคืนถัดไป...</p>
      </div>`;
    return;
  }
  
  if (isBanned) {
    panel.innerHTML = `
      <div class="day-silenced-msg">
        <div class="silenced-icon">🚫</div>
        <h4>คุณถูกแบนโดยหญิงชรา!</h4>
        <p>คุณไม่มีสิทธิ์โหวตในวันนี้ แต่ยังพูดคุยได้ตามปกติ</p>
      </div>`;
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
    const verdict = result.isWolf ? "🐺 หมาป่า!" : "✅ ชาวบ้าน";
    const color   = result.isWolf ? "#ef4444" : "#10b981";
    el.classList.remove("hidden");
    el.style.cssText = `color:${color}; border-color:${color}40; background:${color}10;`;
    el.textContent = `🔮 ${result.targetName} คือ ${verdict}`;
  } else {
    el.classList.add("hidden");
  }
}

// ─── Player Sidebar (player list) ─────────────────────────────────────────────

function renderPlayerSidebar(players, hostId) {
  const list  = document.getElementById("game-player-list");
  if (!list) return;

  const myRole = players[STATE.playerId]?.role || "";
  const lovers = STATE.roomData?.lovers;

  list.innerHTML = Object.entries(players)
    .filter(([id]) => id !== hostId)  // exclude GM from sidebar
    .map(([id, p]) => {
      const status = p.isAlive ? "alive" : "dead";
      const isMe   = id === STATE.playerId;
      let roleHint = "";
      if (myRole === "werewolf" && p.role === "werewolf" && !isMe) {
        roleHint = `<span class="wolf-hint">🐺</span>`;
      }
      
      // Status badges for sidebar
      const pStatus = p.status || {};
      let statusBadges = "";
      if (pStatus.silenced) statusBadges += `<span class="sb-badge sb-silenced">🤐</span>`;
      if (pStatus.banned) statusBadges += `<span class="sb-badge sb-banned">🚫</span>`;
      if (pStatus.lover) statusBadges += `<span class="sb-badge sb-lover">💘</span>`;
      
      return `
        <div class="player-status player-${status} ${isMe ? "player-me" : ""}">
          <div class="ps-avatar ${status}">${p.name.charAt(0).toUpperCase()}</div>
          <span class="ps-name">${escapeHtml(p.name)} ${isMe ? "<em>(คุณ)</em>" : ""} ${roleHint} ${statusBadges}</span>
          <span class="ps-status">${p.isAlive ? "" : "💀"}</span>
        </div>`;
    }).join("");
}

// ─── Elimination Banner ────────────────────────────────────────────────────────

export function showEliminationBanner(elim) {
  const banner = document.getElementById("elimination-banner");
  const fxOverlay = document.getElementById("fx-elimination");
  const fxText = document.getElementById("fx-elimination-text");

  if (!banner) return;
  if (!elim) { banner.classList.add("hidden"); return; }

  let text = "";
  let isKill = false;
  let fxType = "";

  if (elim.reason === "protected")  text = "🛡️ แพทย์ช่วยเหลือ! ไม่มีใครตายในคืนนี้";
  else if (elim.reason === "no-action") text = "🌙 คืนอันเงียบสงัด... ไม่มีใครเสียชีวิต";
  else if (elim.reason === "werewolf") {
    text = `🐺 ${elim.playerName} ถูกหมาป่าสังหาร! พวกเขาคือ ${getRoleConfig(elim.playerRole).name}`;
    isKill = true; fxType = "active-werewolf";
  }
  else if (elim.reason === "vote") {
    text = `🗳️ ${elim.playerName} ถูกโหวตไล่ออก! พวกเขาคือ ${getRoleConfig(elim.playerRole).name}`;
    isKill = true; fxType = "active-vote";
  }
  else if (elim.reason === "tie")           text = "🗳️ โหวตเสมอ! ไม่มีผู้ถูกกำจัดในรอบนี้";
  else if (elim.reason === "skipped")       text = "🗳️ GM ข้ามรอบโหวต";
  else if (elim.reason === "prince_saved")  text = `👑 ${elim.playerName} ถูกโหวต แต่รอดชีวิต! เพราะเขาคือเจ้าชาย 👑`;
  else {
    text = elim.playerName ? `${elim.playerName} ถูกกำจัดออก` : "";
    if (elim.playerName) { isKill = true; fxType = "active-vote"; }
  }

  if (text) {
    banner.textContent = text;
    banner.classList.remove("hidden");
    
    if (isKill && fxOverlay && fxText) {
      fxText.textContent = `${elim.playerName} ตาย!`;
      fxOverlay.className = `fx-overlay ${fxType}`;
      fxOverlay.classList.remove("hidden");
      
      // Delay dismissing the screen blocking effect
      setTimeout(() => {
        fxOverlay.classList.add("hidden");
        fxOverlay.className = "fx-overlay hidden";
      }, 4000);
    }
    
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
    if (winner === "werewolf") {
      if (iconEl)  iconEl.textContent  = "🐺";
      if (titleEl) titleEl.textContent = "หมาป่าชนะ!";
      if (subEl)   subEl.textContent   = "หมู่บ้านตกอยู่ในความมืด หมาป่าครองคืนแล้ว...";
    } else if (winner === "villager") {
      if (iconEl)  iconEl.textContent  = "🏘️";
      if (titleEl) titleEl.textContent = "ชาวบ้านชนะ!";
      if (subEl)   subEl.textContent   = "หมู่บ้านปลอดภัยแล้ว! หมาป่าทุกตัวถูกจับได้หมด";
    } else {
      if (iconEl)  iconEl.textContent  = "🎭";
      if (titleEl) titleEl.textContent = "ผู้เล่นอิสระชนะ!";
      if (subEl)   subEl.textContent   = "ฝ่ายอิสระบรรลุเป้าหมายการเอาชีวิตรอดของตนเอง!";
    }
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

  // Reset lobby button visibility (Only for Host)
  const resetBtn = document.getElementById("btn-reset-lobby");
  if (resetBtn) {
    if (STATE.isHost) {
      resetBtn.classList.remove("hidden");
    } else {
      resetBtn.classList.add("hidden");
    }
  }
}

// ─── Kick / Kill Player ────────────────────────────────────────────────────────

async function kickPlayer(playerId) {
  if (!STATE.isHost) return;
  await remove(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${playerId}`));
}

window._togglePlayerAlive = async function(id, isDead) {
  if (!STATE.isHost) return;
  // isDead=true → revive (isAlive=true), isDead=false → kill (isAlive=false)
  const toLive = !!isDead;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}`), { isAlive: toLive });

  if (!toLive) {
    // Just killed — check if this player is a hunter
    const player = STATE.roomData?.players?.[id];
    if (player?.role === "hunter") {
      await triggerHunterAbility(id);
    }
    
    // Check lover death (Cupid mechanic)
    const lovers = STATE.roomData?.lovers;
    if (lovers) {
      const { player1, player2 } = lovers;
      if (id === player1) {
        const loverData = STATE.roomData?.players?.[player2];
        if (loverData?.isAlive) {
          await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${player2}`), { isAlive: false });
        }
      } else if (id === player2) {
        const loverData = STATE.roomData?.players?.[player1];
        if (loverData?.isAlive) {
          await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${player1}`), { isAlive: false });
        }
      }
    }
  } else {
    // Revived — clear hunterPending if it was them
    if (STATE.roomData?.hunterPending === id) {
      await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), { hunterPending: null });
    }
  }
};

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
  // Clear all module-level cached state
  lastPlayersStr = null;
  lastRoleDeckCountsStr = null;
  lastStatus = null;
  lastPhase  = null;
  subscribeToRoom._lastNightActions = null;
  subscribeToRoom._lastNightTurn = null;
  subscribeToRoom._lastHunter = null;
  subscribeToRoom._lastPrivate = null;
  selectedNightTargets = [];
  resetVoteSelection();
  try { localStorage.removeItem("ww_session"); } catch (_) {}
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
window._setNightTurn = setNightTurn;
window._approveAction = approveNightAction;
window._rejectAction = rejectNightAction;

window._updateDeckCount = async function (role, change) {
  if (!STATE.isHost) return;
  const currentCounts = STATE.roomData?.roleDeckCounts || { werewolf: 1, seer: 1, doctor: 1, villager: 1 };
  const val = (currentCounts[role] || 0) + change;
  if (val < 0) return;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/roleDeckCounts`), {
    [role]: val
  });
};

let selectedNightTargets = [];
window._nightAction = async function (role, targetId, btnEl, extraData = null) {
  const roleCfg = ROLES[role];
  
  if (targetId === "skip") {
    selectedNightTargets = [];
    document.querySelectorAll(".night-target-btn").forEach(b => { b.disabled = true; });
    btnEl.innerHTML = `ข้ามแล้ว...`;
    await submitNightAction(role, "skip", "skip");
    const np = document.getElementById("night-panel");
    if (np) np.innerHTML = `<div class="night-done"><span class="check-anim">✅</span><p>ส่งการกระทำแล้วรอ GM ประกาศ...</p></div>`;
    return;
  }

  if (roleCfg.actionType === "target2") {
     if (selectedNightTargets.includes(targetId)) return;
     selectedNightTargets.push(targetId);
     
     if (btnEl.parentElement && btnEl.parentElement.classList.contains("witch-card")) {
         btnEl.parentElement.classList.add("night-selected");
     } else {
         btnEl.classList.add("night-selected");
     }

     if (selectedNightTargets.length < 2) return;
     
     document.querySelectorAll(".night-target-btn").forEach(b => { b.disabled = true; });
     await submitNightAction(role, selectedNightTargets.join(","), extraData);
     selectedNightTargets = [];
     const np = document.getElementById("night-panel");
     if (np) np.innerHTML = `<div class="night-done"><span class="check-anim">✅</span><p>ส่งการกระทำแล้วรอ GM ประกาศ...</p></div>`;
     return;
  }

  document.querySelectorAll(".night-target-btn").forEach(b => {
    b.classList.remove("night-selected");
    b.disabled = true;
    const btns = b.querySelectorAll("button");
    if(btns) btns.forEach(bb => bb.disabled = true);
  });
  
  if (btnEl.parentElement && btnEl.parentElement.classList.contains("witch-card")) {
      btnEl.parentElement.classList.add("night-selected");
  } else {
      btnEl.classList.add("night-selected");
  }

  await submitNightAction(role, targetId, extraData);

  const np = document.getElementById("night-panel");
  if (np) np.innerHTML = `<div class="night-done"><span class="check-anim">✅</span><p>ส่งการกระทำแล้ว รอ GM ประกาศ...</p></div>`;
};

export { persistSession, resetState, showView };
