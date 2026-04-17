/**
 * game.js — Core game logic
 * Role assignment, phase transitions, night resolution, win condition
 */

import { ref, update, get, remove } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { db, DB_PREFIX, STATE } from "./app.js";
import { eliminatePlayer } from "./voting.js";

// ─── Role Configuration ────────────────────────────────────────────────────────

const ROLES = {
  werewolf: { name: "มนุษย์หมาป่า", icon: "🐺", team: "werewolf", color: "#ef4444",
    description: "ล่าชาวบ้านหนึ่งคนในแต่ละคืน ชนะเมื่อหมาป่ามีจำนวนเท่ากับหรือมากกว่าชาวบ้านที่เหลือ" },
  seer:     { name: "หมอดู",   icon: "🔮", team: "villager", color: "#a78bfa",
    description: "ในแต่ละคืน เลือกผู้เล่นหนึ่งคนเพื่อเปิดเผยบทบาทที่แท้จริงของเขา (รู้เฉพาะตัวเอง)" },
  doctor:   { name: "แพทย์",   icon: "💉", team: "villager", color: "#10b981",
    description: "ในแต่ละคืน ปกป้องผู้เล่นหนึ่งคนจากการถูกหมาป่าโจมตี สามารถรักษาตัวเองได้ครั้งเดียว" },
  villager: { name: "ชาวบ้าน", icon: "🏘️", team: "villager", color: "#f59e0b",
    description: "ไม่มีพลังพิเศษ ใช้เหตุผลและโหวตเอาหมาป่าออกก่อนที่มันจะสายเกินไป" },
};

export function getRoleConfig(roleKey) {
  return ROLES[roleKey] || ROLES.villager;
}

// ─── Role Assignment ───────────────────────────────────────────────────────────

export function assignRoles(playerIds) {
  const count = playerIds.length;
  const roles = [];

  // Werewolf scaling: 1 wolf per 3-4 players
  let wolfCount = 1;
  if (count >= 7) wolfCount = 2;
  if (count >= 11) wolfCount = 3;

  for (let i = 0; i < wolfCount; i++) roles.push("werewolf");

  // Special roles (if enough players)
  if (count >= 4) roles.push("seer");
  if (count >= 5) roles.push("doctor");

  // Fill rest with villagers
  while (roles.length < count) roles.push("villager");

  // Shuffle
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
  if (ids.length < 4) {
    alert("ต้องมีผู้เล่นอย่างน้อย 4 คนเพื่อเริ่มเกม!");
    return;
  }

  const roleMap = assignRoles(ids);
  const playerUpdates = {};
  for (const id of ids) {
    playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/role`] = roleMap[id];
    playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/isAlive`] = true;
    playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/vote`] = "";
    playerUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/isReady`] = false;
  }

  const nightTimer = Date.now() + 60 * 1000; // 60 seconds night

  await update(ref(db), {
    ...playerUpdates,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/status`]: "playing",
    [`${DB_PREFIX}/rooms/${STATE.roomId}/phase`]: "night",
    [`${DB_PREFIX}/rooms/${STATE.roomId}/dayCount`]: 1,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/timerEnd`]: nightTimer,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/lastElimination`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/winnerTeam`]: null,
  });
}

// ─── Phase: Night ──────────────────────────────────────────────────────────────

export async function startNightPhase() {
  if (!STATE.isHost) return;
  const dayCount = (STATE.roomData?.dayCount || 1) + 1;
  const nightTimer = Date.now() + 60 * 1000;

  // Clear votes
  const players = STATE.roomData?.players || {};
  const voteClears = {};
  for (const id of Object.keys(players)) {
    voteClears[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/vote`] = "";
  }

  await update(ref(db), {
    ...voteClears,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/phase`]: "night",
    [`${DB_PREFIX}/rooms/${STATE.roomId}/dayCount`]: dayCount,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/timerEnd`]: nightTimer,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/lastElimination`]: null,
  });
}

// ─── Phase: Day ───────────────────────────────────────────────────────────────

export async function startDayPhase() {
  if (!STATE.isHost) return;
  const dayTimer = Date.now() + 3 * 60 * 1000; // 3-minute discussion

  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    phase: "day",
    timerEnd: dayTimer,
  });
}

// ─── Phase: Voting ────────────────────────────────────────────────────────────

export async function startVotingPhase() {
  if (!STATE.isHost) return;
  const voteTimer = Date.now() + 2 * 60 * 1000; // 2-minute vote window

  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    phase: "voting",
    timerEnd: voteTimer,
  });
}

// ─── Night Action Submission ───────────────────────────────────────────────────

export async function submitNightAction(role, targetId) {
  // Write to nightActions in room
  const actionMap = {
    werewolf: "werewolfTarget",
    seer: "seerTarget",
    doctor: "doctorTarget",
  };
  const key = actionMap[role];
  if (!key) return;

  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`), {
    [key]: targetId,
    [`${key}Done`]: true,
  });

  // For Seer, also write private result
  if (role === "seer") {
    const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${targetId}`));
    const targetData = snapshot.val();
    if (targetData) {
      await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/privateData/${STATE.playerId}`), {
        seerResult: {
          targetId,
          targetName: targetData.name,
          targetRole: targetData.role,
          timestamp: Date.now(),
        },
      });
    }
  }

  // Check if all required actions are submitted
  await checkNightActionsComplete();
}

async function checkNightActionsComplete() {
  if (!STATE.isHost) return;
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`));
  const room = snapshot.val();
  if (!room || room.phase !== "night") return;

  const players = room.players || {};
  const actions = room.nightActions || {};

  const aliveRoles = Object.values(players)
    .filter(p => p.isAlive)
    .map(p => p.role);

  const hasWolf = aliveRoles.includes("werewolf");
  const hasSeer = aliveRoles.includes("seer");
  const hasDoctor = aliveRoles.includes("doctor");

  const wolfDone = !hasWolf || actions.werewolfTargetDone;
  const seerDone = !hasSeer || actions.seerTargetDone;
  const doctorDone = !hasDoctor || actions.doctorTargetDone;

  if (wolfDone && seerDone && doctorDone) {
    await resolveNight(room);
  }
}

// ─── Night Resolution ──────────────────────────────────────────────────────────

export async function resolveNight(roomData) {
  if (!STATE.isHost) return;
  const actions = roomData.nightActions || {};
  const players = roomData.players || {};

  const werewolfTarget = actions.werewolfTarget;
  const doctorTarget = actions.doctorTarget;

  let killedPlayerId = null;

  if (werewolfTarget && werewolfTarget !== doctorTarget) {
    // Kill target (doctor didn't heal them)
    killedPlayerId = werewolfTarget;
  }

  // Announce result and move to day
  if (killedPlayerId && players[killedPlayerId]?.isAlive) {
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${killedPlayerId}`), {
      isAlive: false,
    });

    const playerName = players[killedPlayerId]?.name;
    const playerRole = players[killedPlayerId]?.role;

    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      lastElimination: {
        playerId: killedPlayerId,
        playerName,
        playerRole,
        reason: "werewolf",
        timestamp: Date.now(),
      },
    });
  } else {
    // No kill (doctor saved or no wolf action)
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      lastElimination: {
        playerId: null,
        playerName: null,
        playerRole: null,
        reason: doctorTarget ? "protected" : "no-action",
        timestamp: Date.now(),
      },
    });
  }

  // Check win after potential kill
  const updatedSnapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players`));
  const updatedPlayers = updatedSnapshot.val() || {};
  const winner = checkWinCondition(updatedPlayers);

  if (winner) {
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      status: "ended",
      phase: "result",
      winnerTeam: winner,
    });
  } else {
    // Transition to day discussion
    const dayTimer = Date.now() + 3 * 60 * 1000;
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      phase: "day",
      timerEnd: dayTimer,
      nightActions: null,
    });
  }
}

// ─── Win Condition ─────────────────────────────────────────────────────────────

export function checkWinCondition(players) {
  const alive = Object.values(players).filter(p => p.isAlive);
  const wolves = alive.filter(p => p.role === "werewolf");
  const villagers = alive.filter(p => p.role !== "werewolf");

  if (wolves.length === 0) return "villager";
  if (wolves.length >= villagers.length) return "werewolf";
  return null; // Game continues
}

// ─── Timer Auto-Transition ────────────────────────────────────────────────────

let timerInterval = null;

export function startPhaseTimer(timerEnd, phase) {
  clearInterval(timerInterval);
  const el = document.getElementById("phase-timer");

  timerInterval = setInterval(async () => {
    const remaining = Math.max(0, Math.floor((timerEnd - Date.now()) / 1000));
    const min = Math.floor(remaining / 60).toString().padStart(2, "0");
    const sec = (remaining % 60).toString().padStart(2, "0");
    if (el) {
      el.textContent = `${min}:${sec}`;
      el.classList.toggle("timer-warning", remaining <= 10);
      el.classList.toggle("timer-critical", remaining <= 5);
    }

    if (remaining <= 0) {
      clearInterval(timerInterval);
      if (!STATE.isHost) return; // Only host advances

      if (phase === "night") {
        // Auto-resolve night even if not all actions submitted
        const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`));
        const room = snapshot.val();
        if (room?.phase === "night") await resolveNight(room);
      } else if (phase === "day") {
        await startVotingPhase();
      } else if (phase === "voting") {
        const { resolveVotes } = await import("./voting.js");
        await resolveVotes();
      }
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

// ─── Reset Room ───────────────────────────────────────────────────────────────

export async function resetToLobby() {
  if (!STATE.isHost) return;
  const players = STATE.roomData?.players || {};
  const resetUpdates = {};
  for (const id of Object.keys(players)) {
    resetUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/role`] = "";
    resetUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/isAlive`] = true;
    resetUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/vote`] = "";
    resetUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/isReady`] = false;
  }
  await update(ref(db), {
    ...resetUpdates,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/status`]: "waiting",
    [`${DB_PREFIX}/rooms/${STATE.roomId}/phase`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/dayCount`]: 0,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/timerEnd`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/lastElimination`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/winnerTeam`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/privateData`]: null,
  });
}
