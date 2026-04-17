/**
 * game.js — Core game logic (GM-mode)
 * Role assignment, phase transitions, night resolution, win condition
 * Host = Game Master (GM) and does NOT receive a role.
 */

import { ref, update, get } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { db, DB_PREFIX, STATE } from "./app.js";

// ─── Role Configuration ────────────────────────────────────────────────────────

export const ROLES = {
  werewolf: { name: "มนุษย์หมาป่า", icon: "🐺", team: "werewolf", color: "#ef4444",
    description: "ล่าชาวบ้านหนึ่งคนในแต่ละคืน ชนะเมื่อจำนวนหมาป่าเท่ากับชาวบ้าน" },
  seer:     { name: "หมอดู",         icon: "🔮", team: "villager", color: "#a78bfa",
    description: "ในแต่ละคืน เลือกเปิดเผยบทบาทที่แท้จริงของผู้เล่นหนึ่งคน" },
  doctor:   { name: "แพทย์",         icon: "💉", team: "villager", color: "#10b981",
    description: "ในแต่ละคืน ปกป้องผู้เล่นหนึ่งคนจากการถูกฆ่า (กันรุมไม่ได้ ช่วยตัวเองได้ 1 ครั้ง)" },
  villager: { name: "ชาวบ้าน",       icon: "🏘️", team: "villager", color: "#f59e0b",
    description: "ไม่มีพลังพิเศษ โหวตไล่หมาป่าในตอนกลางวัน" },
  witch:    { name: "แม่มด",         icon: "🧹", team: "villager", color: "#d946ef",
    description: "มียาชุบชีวิต 1 ขวด และยาพิษ 1 ขวด (ใช้ได้แค่อย่างละ 1 ครั้งตลอดเกม)" },
  hunter:   { name: "พรานป่า",       icon: "🔫", team: "villager", color: "#ea580c",
    description: "หากตายหรือถูกโหวตออก สามารถลาก 1 คนให้ตายตามไปด้วยได้" },
  cupid:    { name: "คิวปิด",        icon: "💘", team: "villager", color: "#f43f5e",
    description: "คืนแรกเลือก 2 คนให้เป็นคู่รัก หากตาย 1 คน อีกคนจะตายตาม" },
  tanner:   { name: "คนฟอกหนัง",     icon: "😤", team: "neutral",  color: "#854d0e",
    description: "ชนะคนเดียวหากถูกโหวตแขวนคอ" },
  minion:   { name: "สมุนหมาป่า",    icon: "🦹", team: "werewolf", color: "#9f1239",
    description: "รู้ว่าใครเป็นหมาป่า (แต่หมาป่าไม่รู้ตัวคุณ) ไม่มีสิทธิ์ฆ่าใคร" },
  sorcerer: { name: "หมอผี",         icon: "🧙‍♂️", team: "werewolf", color: "#4f46e5",
    description: "คืนนี้ส่องหาหมอดู (จะรู้แค่ว่าใช่หมอดูหรือไม่)" },
  gm:       { name: "ผู้ดำเนินเกม", icon: "🎭", team: "none",     color: "#8b5cf6",
    description: "คุณคือผู้ดำเนินเกม ควบคุมทุกเฟส" },
};

export function getRoleConfig(roleKey) {
  return ROLES[roleKey] || ROLES.villager;
}

// ─── Role Assignment (excludes GM/host) ────────────────────────────────────────

export function assignRoles(playerIds, customDeck) {
  const count = playerIds.length;
  let roles = customDeck ? [...customDeck] : [];

  // Fallback if no custom deck provided or sizes mismatch
  if (roles.length !== count) {
    roles = [];
    let wolfCount = count >= 7 ? 2 : 1;
    for (let i = 0; i < wolfCount; i++) roles.push("werewolf");
    if (count >= 4) roles.push("seer");
    if (count >= 5) roles.push("doctor");
    while (roles.length < count) roles.push("villager");
  }

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
  const room = STATE.roomData || {};
  const players = room.players || {};
  const ids = Object.keys(players);
  const nonGMIds = ids.filter(id => id !== STATE.playerId);

  if (nonGMIds.length < 4) {
    alert("ต้องมีผู้เล่นอย่างน้อย 4 คน (ไม่นับผู้ดำเนินเกม)!");
    return;
  }

  const counts = room.roleDeckCounts || {};
  let customDeck = [];
  for (const [r, c] of Object.entries(counts)) {
    for (let i = 0; i < c; i++) customDeck.push(r);
  }
  if (customDeck.length === 0) customDeck = null; // trigger fallback if empty

  if (customDeck && customDeck.length !== nonGMIds.length) {
    alert("จำนวนการ์ดไม่เท่ากับจำนวนผู้เล่นที่พร้อม!");
    return;
  }

  const roleMap = assignRoles(nonGMIds, customDeck);
  const updates = {};
  for (const [pId, roleStr] of Object.entries(roleMap)) {
    updates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${pId}/role`] = roleStr;
    updates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${pId}/isAlive`] = true;
    updates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${pId}/vote`] = "";
  }
  
  // Set GM role
  updates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}/role`] = "gm";
  updates[`${DB_PREFIX}/rooms/${STATE.roomId}/status`] = "playing";
  updates[`${DB_PREFIX}/rooms/${STATE.roomId}/phase`] = "standby";

  await update(ref(db), updates);
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

export async function submitNightAction(role, targetId, extraData = null) {
  // Support custom extra actions like Witch poison vs heal
  const actionMap = {
    werewolf: "werewolfTarget",
    seer:     "seerTarget",
    doctor:   "doctorTarget",
    witch:    "witchTarget",
    cupid:    "cupidTarget",
    sorcerer: "sorcererTarget"
  };
  const key = actionMap[role];
  if (!key) return;

  const payload = {
    [key]:          targetId,
    [`${key}Done`]: true,
  };
  if (role === "witch") {
    payload["witchActionType"] = extraData;
  }

  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`), payload);

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

  const activeRoles = new Set(
    Object.values(players)
      .filter(p => p.isAlive && p.role !== "gm")
      .map(p => p.role)
  );

  const reqCheck = [
    { role: "werewolf", key: "werewolfTargetDone" },
    { role: "seer",     key: "seerTargetDone" },
    { role: "doctor",   key: "doctorTargetDone" },
    { role: "sorcerer", key: "sorcererTargetDone" },
    { role: "witch",    key: "witchTargetDone" }
  ];

  if (room.dayCount === 1) {
    reqCheck.push({ role: "cupid", key: "cupidTargetDone" });
  }

  const allDone = reqCheck.every(({ role, key }) => {
    return !activeRoles.has(role) || actions[key];
  });

  if (allDone) {
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
  const witchTarget    = actions.witchTarget;
  const witchType      = actions.witchActionType; // 'heal' or 'poison'

  let killedIds = [];

  // Werewolf kill
  let wolfKill = null;
  if (werewolfTarget && werewolfTarget !== doctorTarget) {
    wolfKill = werewolfTarget;
  }

  // Witch heal
  if (wolfKill && witchType === "heal" && witchTarget === wolfKill) {
    wolfKill = null;
  }

  if (wolfKill) killedIds.push(wolfKill);

  // Witch poison
  if (witchType === "poison" && witchTarget) {
    if (!killedIds.includes(witchTarget)) killedIds.push(witchTarget);
  }

  // Cupid Lovers Logic could go here (if one dies, the other dies), but we'll leave it to GM to manage complicated death chains manually for now, or just implement basic linking.
  // We'll record lovers for GM.
  
  // Apply kill silently (before GM announces)
  for (const id of killedIds) {
    if (players[id]?.isAlive) {
      await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}`), {
        isAlive: false,
      });
    }
  }

  let reason = "no-action";
  if (killedIds.length > 0) {
    reason = witchType === "poison" ? "witch-and-wolf" : "werewolf";
  } else if (doctorTarget || witchType === "heal") {
    reason = "protected";
  }

  const nightResult = {
    killedId:   killedIds[0] || null, // Primary killed
    killedIds:  killedIds,            // Array of killed (in case of double kill)
    wolfTarget:  werewolfTarget  || null,
    doctorTarget: doctorTarget   || null,
    witchTarget: witchTarget || null,
    witchType: witchType || null,
    cupidTarget1: actions.cupidTarget || null,
    cupidTarget2: actions.cupidTarget2 || null,
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
    playerName: players[result.killedId]?.name,
    playerRole: players[result.killedId]?.role,
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
