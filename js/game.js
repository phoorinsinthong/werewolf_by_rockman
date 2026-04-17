/**
 * game.js — Core game logic (GM-mode)
 * Role assignment, phase transitions, night resolution, win condition
 * Host = Game Master (GM) and does NOT receive a role.
 */

import { ref, update, get } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { db, DB_PREFIX, STATE } from "./app.js";

// ─── Role Configuration ────────────────────────────────────────────────────────

const ROLES = {
  werewolf: { name: "มนุษย์หมาป่า", icon: "🐺", team: "werewolf", color: "#ef4444",
    description: "ล่าชาวบ้านหนึ่งคนในแต่ละคืน ชนะเมื่อหมาป่ามีจำนวนเท่ากับหรือมากกว่าชาวบ้านที่เหลือ" },
  seer:     { name: "หมอดู",         icon: "🔮", team: "villager", color: "#a78bfa",
    description: "ในแต่ละคืน เลือกผู้เล่นหนึ่งคนเพื่อเปิดเผยบทบาทที่แท้จริงของเขา (รู้เฉพาะตัวเอง)" },
  doctor:   { name: "แพทย์",         icon: "💉", team: "villager", color: "#10b981",
    description: "ในแต่ละคืน ปกป้องผู้เล่นหนึ่งคนจากการถูกหมาป่าโจมตี สามารถรักษาตัวเองได้ครั้งเดียว" },
  villager: { name: "ชาวบ้าน",       icon: "🏘️", team: "villager", color: "#f59e0b",
    description: "ไม่มีพลังพิเศษ ใช้เหตุผลและโหวตเอาหมาป่าออกก่อนที่มันจะสายเกินไป" },
  gm:       { name: "ผู้ดำเนินเกม", icon: "🎭", team: "none",     color: "#8b5cf6",
    description: "คุณคือผู้ดำเนินเกม ควบคุมทุกเฟส และประกาศผู้ชนะ" },
};

export function getRoleConfig(roleKey) {
  return ROLES[roleKey] || ROLES.villager;
}

// ─── Role Assignment (excludes GM/host) ────────────────────────────────────────

export function assignRoles(playerIds) {
  const count = playerIds.length;
  const roles = [];

  let wolfCount = 1;
  if (count >= 7)  wolfCount = 2;
  if (count >= 11) wolfCount = 3;

  for (let i = 0; i < wolfCount; i++) roles.push("werewolf");

  if (count >= 4) roles.push("seer");
  if (count >= 5) roles.push("doctor");

  while (roles.length < count) roles.push("villager");

  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  const shuffledIds = [...playerIds].sort(() => Math.random() - 0.5);
  const assignments = {};
  shuffledIds.forEach((id, idx) => {
    assignments[id] = roles[idx] || "villager";
  });
  return assignments;
}

// ─── Game Start ────────────────────────────────────────────────────────────────

export async function startGame() {
  if (!STATE.isHost) return;
  const players = STATE.roomData?.players || {};
  const ids = Object.keys(players);

  // GM (host) is excluded from player roles
  const nonGMIds = ids.filter(id => id !== STATE.playerId);

  if (nonGMIds.length < 4) {
    alert("ต้องมีผู้เล่นอย่างน้อย 4 คน (ไม่นับผู้ดำเนินเกม)!");
    return;
  }

  const roleMap = assignRoles(nonGMIds);
  const playerUpdates = {};

  // Mark host as GM
  playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}/role`]    = "gm";
  playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}/isAlive`] = true;
  playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}/vote`]    = "";
  playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}/isReady`] = true;

  for (const id of nonGMIds) {
    playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/role`]    = roleMap[id];
    playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/isAlive`] = true;
    playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/vote`]    = "";
    playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/isReady`] = false;
  }

  await update(ref(db), {
    ...playerUpdates,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/status`]:          "playing",
    [`${DB_PREFIX}/rooms/${STATE.roomId}/phase`]:           "standby",   // GM controls first night
    [`${DB_PREFIX}/rooms/${STATE.roomId}/dayCount`]:        0,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/timerEnd`]:        null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`]:    null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/lastElimination`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/winnerTeam`]:      null,
  });
}

// ─── Phase: Night (GM-triggered) ──────────────────────────────────────────────

export async function startNightPhase() {
  if (!STATE.isHost) return;
  const dayCount = (STATE.roomData?.dayCount || 0) + 1;
  const nightTimer = Date.now() + 90 * 1000; // display-only countdown

  // Clear previous votes for non-GM players
  const players = STATE.roomData?.players || {};
  const voteClears = {};
  for (const id of Object.keys(players)) {
    if (players[id].role !== "gm") {
      voteClears[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/vote`] = "";
    }
  }

  await update(ref(db), {
    ...voteClears,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/phase`]:           "night",
    [`${DB_PREFIX}/rooms/${STATE.roomId}/dayCount`]:        dayCount,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/timerEnd`]:        nightTimer,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`]:    null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/lastElimination`]: null,
  });
}

// ─── Night Action Submission (player-triggered) ───────────────────────────────

export async function submitNightAction(role, targetId) {
  const actionMap = {
    werewolf: "werewolfTarget",
    seer:     "seerTarget",
    doctor:   "doctorTarget",
  };
  const key = actionMap[role];
  if (!key) return;

  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`), {
    [key]:          targetId,
    [`${key}Done`]: true,
  });

  // Seer gets private result
  if (role === "seer") {
    const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${targetId}`));
    const targetData = snapshot.val();
    if (targetData) {
      await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/privateData/${STATE.playerId}`), {
        seerResult: {
          targetId,
          targetName: targetData.name,
          targetRole: targetData.role,
          timestamp:  Date.now(),
        },
      });
    }
  }

  await checkNightActionsComplete();
}

// ─── Check if all night actions are done ──────────────────────────────────────

async function checkNightActionsComplete() {
  if (!STATE.isHost) return;
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`));
  const room = snapshot.val();
  if (!room || room.phase !== "night") return;

  const players = room.players || {};
  const actions  = room.nightActions || {};

  // Only count alive non-GM players
  const aliveRoles = Object.values(players)
    .filter(p => p.isAlive && p.role !== "gm")
    .map(p => p.role);

  const hasWolf   = aliveRoles.includes("werewolf");
  const hasSeer   = aliveRoles.includes("seer");
  const hasDoctor = aliveRoles.includes("doctor");

  const wolfDone   = !hasWolf   || actions.werewolfTargetDone;
  const seerDone   = !hasSeer   || actions.seerTargetDone;
  const doctorDone = !hasDoctor || actions.doctorTargetDone;

  if (wolfDone && seerDone && doctorDone) {
    await resolveNight(room);
  }
}

// ─── Night Resolution (auto, silent — GM announces later) ─────────────────────

export async function resolveNight(roomData) {
  if (!STATE.isHost) return;
  const actions = roomData.nightActions || {};
  const players = roomData.players   || {};

  const werewolfTarget = actions.werewolfTarget;
  const doctorTarget   = actions.doctorTarget;

  let killedPlayerId = null;
  if (werewolfTarget && werewolfTarget !== doctorTarget) {
    killedPlayerId = werewolfTarget;
  }

  // Apply kill silently (before GM announces)
  if (killedPlayerId && players[killedPlayerId]?.isAlive) {
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${killedPlayerId}`), {
      isAlive: false,
    });
  }

  const reason = killedPlayerId
    ? "werewolf"
    : (doctorTarget && doctorTarget === werewolfTarget ? "protected" : "no-action");

  const nightResult = {
    killedId:   killedPlayerId   || null,
    killedName: killedPlayerId   ? players[killedPlayerId]?.name : null,
    killedRole: killedPlayerId   ? players[killedPlayerId]?.role : null,
    wolfTarget:  werewolfTarget  || null,
    wolfName:    werewolfTarget  ? players[werewolfTarget]?.name  : null,
    doctorTarget: doctorTarget   || null,
    doctorName:   doctorTarget   ? players[doctorTarget]?.name    : null,
    reason,
  };

  // Move to "night-done" — GM panel shows result privately
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    phase:                  "night-done",
    timerEnd:               null,
    "nightActions/result":  nightResult,
    "nightActions/allResolved": true,
  });
}

// ─── GM Announces Night Result → Day ──────────────────────────────────────────

export async function gmAnnounceNightResult() {
  if (!STATE.isHost) return;
  const room = STATE.roomData;
  if (!room || room.phase !== "night-done") return;

  const result = room.nightActions?.result || {};

  // Check win (kill already applied in resolveNight)
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players`));
  const players  = snapshot.val() || {};
  const winner   = checkWinCondition(players);

  const elimRecord = result.killedId ? {
    playerId:   result.killedId,
    playerName: result.killedName,
    playerRole: result.killedRole,
    reason:     result.reason,
    timestamp:  Date.now(),
  } : {
    playerId:   null,
    playerName: null,
    playerRole: null,
    reason:     result.reason || "no-action",
    timestamp:  Date.now(),
  };

  if (winner) {
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      status:           "ended",
      phase:            "result",
      winnerTeam:       winner,
      nightActions:     null,
      lastElimination:  elimRecord,
    });
  } else {
    const dayTimer = Date.now() + 3 * 60 * 1000;
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      phase:           "day",
      timerEnd:        dayTimer,
      nightActions:    null,
      lastElimination: elimRecord,
    });
  }
}

// ─── Phase: Day (used internally) ─────────────────────────────────────────────

export async function startDayPhase() {
  if (!STATE.isHost) return;
  const dayTimer = Date.now() + 3 * 60 * 1000;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    phase:    "day",
    timerEnd: dayTimer,
  });
}

// ─── Phase: Voting (GM-triggered) ─────────────────────────────────────────────

export async function startVotingPhase() {
  if (!STATE.isHost) return;
  const voteTimer = Date.now() + 3 * 60 * 1000;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    phase:    "voting",
    timerEnd: voteTimer,
  });
}

// ─── Force Announce Winner (GM override) ──────────────────────────────────────

export async function announceWinner(team) {
  if (!STATE.isHost) return;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    status:    "ended",
    phase:     "result",
    winnerTeam: team,
  });
}

// ─── Win Condition ─────────────────────────────────────────────────────────────

export function checkWinCondition(players) {
  // Exclude GM from win condition calculation
  const alive     = Object.values(players).filter(p => p.isAlive && p.role !== "gm");
  const wolves    = alive.filter(p => p.role === "werewolf");
  const villagers = alive.filter(p => p.role !== "werewolf");

  if (wolves.length === 0)              return "villager";
  if (wolves.length >= villagers.length) return "werewolf";
  return null;
}

// ─── Timer (display-only, no auto-advance) ─────────────────────────────────────

let timerInterval = null;

export function startPhaseTimer(timerEnd, phase) {
  clearInterval(timerInterval);
  const el = document.getElementById("phase-timer");

  if (!timerEnd) {
    if (el) { el.textContent = "--:--"; el.className = ""; }
    return;
  }

  timerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((timerEnd - Date.now()) / 1000));
    const min = Math.floor(remaining / 60).toString().padStart(2, "0");
    const sec = (remaining % 60).toString().padStart(2, "0");
    if (el) {
      el.textContent = `${min}:${sec}`;
      el.classList.toggle("timer-warning",  remaining <= 15 && remaining > 5);
      el.classList.toggle("timer-critical", remaining <= 5);
    }
    if (remaining <= 0) {
      clearInterval(timerInterval);
      if (el) el.textContent = "⏸";
    }
  }, 1000);
}

export function stopPhaseTimer() {
  clearInterval(timerInterval);
}

// ─── Seer Private Data ────────────────────────────────────────────────────────

export async function getSeerResult() {
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/privateData/${STATE.playerId}/seerResult`));
  return snapshot.val();
}

// ─── Reset Room to Lobby ───────────────────────────────────────────────────────

export async function resetToLobby() {
  if (!STATE.isHost) return;
  const players = STATE.roomData?.players || {};
  const resetUpdates = {};
  for (const id of Object.keys(players)) {
    resetUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/role`]    = "";
    resetUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/isAlive`] = true;
    resetUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/vote`]    = "";
    resetUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/isReady`] = false;
  }
  await update(ref(db), {
    ...resetUpdates,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/status`]:          "waiting",
    [`${DB_PREFIX}/rooms/${STATE.roomId}/phase`]:           null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/dayCount`]:        0,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/timerEnd`]:        null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`]:    null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/lastElimination`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/winnerTeam`]:      null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/privateData`]:     null,
  });
}
