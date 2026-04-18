/**
 * game.js — Core game logic (GM-mode)
 * Role assignment, phase transitions, night resolution, win condition
 * Host = Game Master (GM) and does NOT receive a role.
 */

import { ref, update, get } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { db, DB_PREFIX, STATE } from "./app.js";

// ─── Role Configuration ────────────────────────────────────────────────────────

export const ROLES = {
  // ─── VILLAGER TEAM ───
  villager: {
    name: "ชาวบ้าน", icon: "🏘️", team: "villager", color: "#f59e0b", actionPhase: "none",
    description: "ไม่มีพลังพิเศษ โหวตไล่หมาป่าในตอนกลางวัน"
  },
  seer: {
    name: "หมอดู", icon: "🔮", team: "villager", color: "#a78bfa", actionPhase: "nightly", actionType: "target",
    description: "ในแต่ละคืน เลือกตรวจผู้เล่น 1 คนว่าเป็นหมาป่าหรือไม่"
  },
  apprentice_seer: {
    name: "หมอดูฝึกหัด", icon: "👓", team: "villager", color: "#8b5cf6", actionPhase: "nightly", actionType: "target",
    description: "เป็นชาวบ้านจนกว่าหมอดูจริงจะตาย จึงจะได้รับพลังหมอดูมาแทน"
  },
  aura_seer: {
    name: "ผู้หยั่งรู้ออร่า", icon: "✨", team: "villager", color: "#c4b5fd", actionPhase: "nightly", actionType: "target",
    description: "ตื่นตอนกลางคืนเพื่อตรวจสอบว่าผู้เล่น 1 คนมีบทบาทพิเศษหรือไม่"
  },
  beholder: {
    name: "ผู้สังเกตการณ์", icon: "👁️", team: "villager", color: "#7c3aed", actionPhase: "none",
    description: "ลืมตาในคืนแรกเพื่อดูว่าใครคือหมอดู"
  },
  bodyguard: {
    name: "ผู้คุ้มกัน", icon: "🛡️", team: "villager", color: "#10b981", actionPhase: "nightly", actionType: "target",
    description: "ปกป้องผู้เล่น 1 คนต่อคืน (ห้ามป้องกันคนเดิมซ้ำติดกัน 2 คืน)"
  },
  cupid: {
    name: "กามเทพ", icon: "💘", team: "villager", color: "#f43f5e", actionPhase: "firstNight", actionType: "target2",
    description: "คืนแรกเลือก 2 คนให้เป็นคู่รัก หากตาย 1 คน อีกคนจะตายตาม"
  },
  diseased: {
    name: "ผู้ป่วย", icon: "🤒", team: "villager", color: "#84cc16", actionPhase: "none",
    description: "หากถูกหมาป่ากัด หมาป่าจะติดเชื้อและล่าใครไม่ได้ในคืนถัดไป"
  },
  drunk: {
    name: "คนเมา", icon: "🍺", team: "villager", color: "#fde047", actionPhase: "none",
    description: "ไม่รู้บทบาทที่แท้จริงจนกว่าจะถึงคืนที่ 3"
  },
  ghost: {
    name: "ผี", icon: "👻", team: "villager", color: "#d1d5db", actionPhase: "none",
    description: "จะถูกฆ่าตายในคืนแรก แต่สามารถส่งข้อความใบ้ 1 ตัวอักษร/วันได้"
  },
  hunter: {
    name: "พรานป่า", icon: "🔫", team: "villager", color: "#ea580c", actionPhase: "none",
    description: "เมื่อตายสามารถลากผู้เล่นคนอื่นให้ตายตามไปด้วย 1 คน"
  },
  idiot: {
    name: "คนโง่", icon: "🤪", team: "villager", color: "#fb923c", actionPhase: "none",
    description: "รู้ว่าใครเป็นหมาป่าในคืนแรก แต่ห้ามออกเสียงโหวตเด็ดขาด"
  },
  insomniac: {
    name: "คนนอนไม่หลับ", icon: "🦉", team: "villager", color: "#6b7280", actionPhase: "nightly", actionType: "none",
    description: "ตื่นกลางคืนเพื่อดูว่าใครลุกจากเตียงบ้าง (ทำ Activity กลางคืน)"
  },
  lycan: {
    name: "ไลแคน", icon: "🐺", team: "villager", color: "#991b1b", actionPhase: "none",
    description: "เป็นชาวบ้าน แต่ถ้าหมอดูส่องจะเห็นเป็นหมาป่า"
  },
  magician: {
    name: "นักมายากล", icon: "🎩", team: "villager", color: "#d946ef", actionPhase: "nightly", actionType: "target",
    description: "สลับการ์ดของผู้เล่นอื่น 1 ครั้งต่อเกม"
  },
  martyr: {
    name: "ผู้พลีชีพ", icon: "🙏", team: "villager", color: "#b91c1c", actionPhase: "none",
    description: "รับผลโหวตประหารและตายแทนคนอื่นในตอนเช้าได้"
  },
  mason: {
    name: "ช่างก่อสร้าง", icon: "🧱", team: "villager", color: "#9ca3af", actionPhase: "none",
    description: "ลืมตาคืนแรกเพื่อมองหาเพื่อน Mason ด้วยกัน"
  },
  mayor: {
    name: "นายกเทศมนตรี", icon: "🏵️", team: "villager", color: "#fcd34d", actionPhase: "none",
    description: "เสียงโหวตแขวนคอของคุณนับเป็น 2 เสียง"
  },
  old_hag: {
    name: "หญิงชรา", icon: "👵", team: "villager", color: "#4b5563", actionPhase: "nightly", actionType: "target",
    description: "แบนไม่ให้ผู้เล่น 1 คนมีสิทธิ์โหวตในวันถัดไป"
  },
  old_man: {
    name: "ชายชรา", icon: "👴", team: "villager", color: "#6b7280", actionPhase: "none",
    description: "ตายโดยธรรมชาติในคืนที่ จำนวนหมาป่า + 1"
  },
  pacifist: {
    name: "ผู้รักสงบ", icon: "🕊️", team: "villager", color: "#34d399", actionPhase: "none",
    description: "ต้องโหวต 'ให้รอด' เสมอ ห้ามโหวตแขวนคอเด็ดขาด"
  },
  pi: {
    name: "นักสืบเอกชน", icon: "🕵️", team: "villager", color: "#6366f1", actionPhase: "nightly", actionType: "target",
    description: "ใช้ 1 ครั้งต่อเกม ตรวจสอบเป้าหมายและคนข้างเคียงว่ามีหมาป่าหรือไม่"
  },
  priest: {
    name: "นักบวช", icon: "📿", team: "villager", color: "#fcd34d", actionPhase: "nightly", actionType: "target",
    description: "ใช้ 1 ครั้งต่อเกม สาดน้ำมนต์ ใครเป็นหมาป่าโดนเข้าไปจะตายทันที"
  },
  prince: {
    name: "เจ้าชาย", icon: "👑", team: "villager", color: "#fbbf24", actionPhase: "none",
    description: "หากถูกโหวตตาย จะรอดชีวิตจากการถูกแขวนคอ 1 ครั้ง"
  },
  spellcaster: {
    name: "ผู้ร่ายเวทย์", icon: "🤐", team: "villager", color: "#8b5cf6", actionPhase: "nightly", actionType: "target",
    description: "ปิดปากผู้เล่น 1 คนกลางคืน ทำให้ตอนเช้าห้ามพูดและห้ามออกเสียง"
  },
  tough_guy: {
    name: "จอมอึด", icon: "💪", team: "villager", color: "#b45309", actionPhase: "none",
    description: "ทนทานการกัดของหมาป่าได้ 1 วัน ค่อยไปขาดใจตายเอาในคืนถัดไป"
  },
  troublemaker: {
    name: "ตัวป่วน", icon: "🤪", team: "villager", color: "#f43f5e", actionPhase: "firstNight", actionType: "target2",
    description: "สลับบทบาทของผู้เล่น 2 คนในคืนแรก"
  },
  witch: {
    name: "แม่มด", icon: "🧹", team: "villager", color: "#d946ef", actionPhase: "nightly", actionType: "extra",
    description: "มียาชุบชีวิต 1 ขวด และยาพิษ 1 ขวด (ใช้อย่างละ 1 ครั้ง)"
  },

  // ─── WEREWOLF TEAM ───
  werewolf: {
    name: "มนุษย์หมาป่า", icon: "🐺", team: "werewolf", color: "#ef4444", actionPhase: "nightly", actionType: "target",
    description: "ร่วมมือกับหมาป่าตัวอื่นโหวตล่าเหยื่อตอนกลางคืน"
  },
  alpha_wolf: {
    name: "จ่าฝูงหมาป่า", icon: "👑🐺", team: "werewolf", color: "#b91c1c", actionPhase: "nightly", actionType: "target",
    description: "ถ้าตาย ฝูงหมาป่าจะเสียขวัญไม่ออกล่าเหยื่อ 1 คืน"
  },
  dire_wolf: {
    name: "หมาป่าโลกันต์", icon: "🔥🐺", team: "werewolf", color: "#dc2626", actionPhase: "firstNight", actionType: "target",
    description: "คืนแรกสาบานตนคู่กับสหาย 1 คน หากสหายตาย คุณตายด้วย"
  },
  lone_wolf: {
    name: "หมาป่าเดียวดาย", icon: "👤🐺", team: "werewolf", color: "#7f1d1d", actionPhase: "nightly", actionType: "target",
    description: "ชนะก็ต่อเมื่อเป็นหมาป่าตัวสุดท้ายที่รอดชีวิต"
  },
  minion: {
    name: "สมุนหมาป่า", icon: "🦹", team: "werewolf", color: "#9f1239", actionPhase: "none",
    description: "รู้ว่าหมาป่าคือใคร ป่วนโหวต และทดสอบเป็นชาวบ้านให้หมอดูเห็น"
  },
  mystic_wolf: {
    name: "หมาป่าผู้หยั่งรู้", icon: "👁️🐺", team: "werewolf", color: "#4f46e5", actionPhase: "nightly", actionType: "target",
    description: "สามารถออกส่องบทบาทที่แท้จริงของผู้เล่น 1 คนได้เหมือนหมอดู"
  },
  sorceress: {
    name: "แม่มดแห่งความมืด", icon: "🔮🐺", team: "werewolf", color: "#indigo", actionPhase: "nightly", actionType: "target",
    description: "ตื่นมาทายหาหมอดู (ส่องดูเพื่อหาว่าใครคือหมอดู)"
  },
  wolf_cub: {
    name: "ลูกหมาป่า", icon: "🐾🐺", team: "werewolf", color: "#f87171", actionPhase: "nightly", actionType: "target",
    description: "หากตาย คืนถัดไปหมาป่าจะโกรธแค้นและล่าเหยื่อได้ถึง 2 คน"
  },
  wolf_man: {
    name: "มนุษย์หมาป่าผู้เนียนตา", icon: "🤵🐺", team: "werewolf", color: "#b91c1c", actionPhase: "nightly", actionType: "target",
    description: "ถ้าหมอดูส่อง จะเห็นคุณเป็นชาวบ้านธรรมดา"
  },

  // ─── INDEPENDENT TEAM ───
  cursed: {
    name: "ผู้ต้องสาป", icon: "🧟", team: "independent", color: "#6b7280", actionPhase: "none",
    description: "เมื่อโดนหมาป่ากัดจะไม่ตาย แต่กลับกลายเป็น 1 ในฝูงหมาป่าแทน"
  },
  doppelganger: {
    name: "ดอปเปลแกงเกอร์", icon: "👥", team: "independent", color: "#10b981", actionPhase: "firstNight", actionType: "target",
    description: "คืนแรกลึงตาเลือกเป้าหมาย เมื่อเป้าหมายตาย คุณจะสวมบทบาทแทน"
  },
  chupacabra: {
    name: "ชูปาคาบรา", icon: "🦇", team: "independent", color: "#065f46", actionPhase: "nightly", actionType: "target",
    description: "ฆ่าคืนละคน ถ้าฆ่าโดนหมาป่า หมาป่าจะตาย (ฆ่าคนธรรมดาไม่ตาย)"
  },
  cult_leader: {
    name: "เจ้าลัทธิ", icon: "🛐", team: "independent", color: "#8b5cf6", actionPhase: "nightly", actionType: "target",
    description: "ดึงคนเข้าลัทธิคืนละ 1 คน ชนะทันทีเมื่อมีเพื่อนร่วมลัทธิทุกคน"
  },
  hoodlum: {
    name: "นักเลง", icon: "🚬", team: "independent", color: "#475569", actionPhase: "firstNight", actionType: "target2",
    description: "เลือก 2 คนในคืนแรก ชนะถ้า 2 คนนั้นตายก่อนกติกาจบ"
  },
  serial_killer: {
    name: "ฆาตกรต่อเนื่อง", icon: "🔪", team: "independent", color: "#dc2626", actionPhase: "nightly", actionType: "target",
    description: "ในแต่ละคืนตื่นมาลอบฆ่าใครก็ได้ ชนะเมื่อรอดเป็นคนสุดท้าย"
  },
  tanner: {
    name: "คนฟอกหนัง", icon: "😤", team: "independent", color: "#ca8a04", actionPhase: "none",
    description: "ชนะเพียงคนเดียวเมื่อยุยงให้ทุกคนโหวตประหารตัวเองเอาไว้ได้"
  },
  vampire: {
    name: "แวมไพร์", icon: "🧛", team: "independent", color: "#9f1239", actionPhase: "nightly", actionType: "target",
    description: "กัดคืนละคน เหยื่อจะเป็นแวมไพร์ ชนะเมื่อมีจำนวนแวมไพร์เยอะที่สุด"
  },

  // ─── Game Master ───
  gm: {
    name: "ผู้ดำเนินเกม", icon: "🎭", team: "none", color: "#8b5cf6", actionPhase: "none",
    description: "คุณคือผู้ดำเนินเกม ควบคุมทุกเฟส"
  },
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
    [`${DB_PREFIX}/rooms/${STATE.roomId}/phase`]: "night",
    [`${DB_PREFIX}/rooms/${STATE.roomId}/dayCount`]: dayCount,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/timerEnd`]: nightTimer,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`]: null,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/lastElimination`]: null,
  });
}

// ─── Night Action Submission (player-triggered) ───────────────────────────────

export async function submitNightAction(role, targetId, extraData = null) {
  const roleCfg = ROLES[role];
  if (!roleCfg || roleCfg.actionPhase === "none") return;

  const payload = {
    [`${role}Target`]: targetId,
    [`${role}TargetDone`]: true,
  };
  if (extraData) payload[`${role}Extra`] = extraData;

  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`), payload);

  // Private result logic handles special roles that get immediate feedback
  if (["seer", "mystic_wolf", "pi", "aura_seer"].includes(role) && targetId) {
    const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${targetId}`));
    const targetData = snapshot.val();
    if (targetData) {
      await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/privateData/${STATE.playerId}`), {
        [`${role}Result`]: {
          targetId,
          targetName: targetData.name,
          targetRole: targetData.role,
          timestamp: Date.now(),
        },
      });
    }
  }

  await checkNightActionsComplete();
}

export async function getSeerResult() {
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/privateData/${STATE.playerId}/seerResult`));
  if (!snapshot.exists()) return null;
  const data = snapshot.val();
  const cfg = ROLES[data.targetRole];

  // A Seer identifies wolves (standard + specialized wolf roles)
  // - Lycan is seen as a wolf despite being on the Villager team.
  // - Wolf Man is seen as a villager despite being on the Werewolf team.
  const wolfRoles = ["werewolf", "alpha_wolf", "dire_wolf", "lone_wolf", "mystic_wolf", "wolf_cub"];
  let isWolf = wolfRoles.includes(data.targetRole);

  if (data.targetRole === "lycan") isWolf = true;
  if (data.targetRole === "wolf_man") isWolf = false;

  return {
    targetName: data.targetName,
    isWolf
  };
}

// ─── Check if all night actions are done ──────────────────────────────────────

async function checkNightActionsComplete() {
  if (!STATE.isHost) return;
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`));
  const room = snapshot.val();
  if (!room || room.phase !== "night") return;

  const players = room.players || {};
  const actions = room.nightActions || {};

  const aliveRoles = Object.values(players).filter(p => p.isAlive && p.role !== "gm").map(p => p.role);

  const allDone = aliveRoles.every(role => {
    const cfg = ROLES[role];
    if (!cfg) return true;
    if (cfg.actionPhase === "nightly") return !!actions[`${role}TargetDone`];
    if (cfg.actionPhase === "firstNight" && room.dayCount === 1) return !!actions[`${role}TargetDone`];
    return true; // actionPhase === "none" etc.
  });

  if (allDone) {
    await resolveNight(room);
  }
}

// ─── Night Resolution (auto, silent — GM announces later) ─────────────────────

export async function resolveNight(roomData) {
  if (!STATE.isHost) return;

  const actions = roomData.nightActions || {};
  const players = roomData.players || {};

  let killedId = null;
  let reason = "none";

  // 1. Identify primary werewolf target
  // (Priority: alpha_wolf > mystic_wolf > werewolf > others)
  const wolfTarget = actions.alpha_wolfTarget || actions.werewolfTarget || actions.mystic_wolfTarget || actions.wolf_cubTarget;

  if (wolfTarget && wolfTarget !== 'skip') {
    killedId = wolfTarget;
    reason = "werewolf";
  }

  // 2. Handle Protections
  const protectedIds = [];
  if (actions.doctorTarget && actions.doctorTarget !== 'skip') protectedIds.push(actions.doctorTarget);
  if (actions.bodyguardTarget && actions.bodyguardTarget !== 'skip') protectedIds.push(actions.bodyguardTarget);

  if (killedId && protectedIds.includes(killedId)) {
    killedId = null;
    reason = "saved";
  }

  // 3. Witch Logic (Heal priority over Poison)
  if (actions.witchExtra === 'heal' && actions.witchTarget === wolfTarget) {
    killedId = null;
    reason = "saved-by-witch";
  } else if (actions.witchExtra === 'poison' && actions.witchTarget && actions.witchTarget !== 'skip') {
    // If nobody was killed by wolves, witch poison becomes the primary death
    // If someone was killed by wolves, poison might be a second death (not fully supported by simple schema yet)
    if (!killedId) {
      killedId = actions.witchTarget;
      reason = "witch-poison";
    }
  }

  // 4. Update the room with the calculated result
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    phase: "night-done",
    timerEnd: null,
    "nightActions/allResolved": true,
    "nightActions/result": {
      killedId,
      reason,
      timestamp: Date.now()
    }
  });
}

// ─── GM Announces Night Result → Day ──────────────────────────────────────────

export async function gmAnnounceNightResult() {
  if (!STATE.isHost) return;
  const room = STATE.roomData;
  if (!room || room.phase !== "night-done") return;

  const result = room.nightActions?.result || {};
  const updates = {};

  // Apply automated kill if any
  if (result.killedId) {
    updates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${result.killedId}/isAlive`] = false;
  }

  // Check win condition AFTER applying kill
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players`));
  const players = snapshot.val() || {};

  // Merge current player state with potential kill for win check
  const playersForWinCheck = { ...players };
  if (result.killedId) {
    playersForWinCheck[result.killedId] = { ...players[result.killedId], isAlive: false };
  }

  const winner = checkWinCondition(playersForWinCheck);

  const elimRecord = result.killedId ? {
    playerId: result.killedId,
    playerName: players[result.killedId]?.name,
    playerRole: players[result.killedId]?.role,
    reason: result.reason,
    timestamp: Date.now(),
  } : {
    playerId: null,
    playerName: null,
    playerRole: null,
    reason: result.reason || "no-action",
    timestamp: Date.now(),
  };

  const finalUpdates = {
    ...updates,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/lastElimination`]: elimRecord,
    [`${DB_PREFIX}/rooms/${STATE.roomId}/nightActions`]: null,
  };

  if (winner) {
    finalUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/status`] = "ended";
    finalUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/phase`] = "result";
    finalUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/winnerTeam`] = winner;
  } else {
    const dayTimer = Date.now() + 3 * 60 * 1000;
    finalUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/phase`] = "day";
    finalUpdates[`${DB_PREFIX}/rooms/${STATE.roomId}/timerEnd`] = dayTimer;
  }

  await update(ref(db), finalUpdates);
}

// ─── Phase: Day (used internally) ─────────────────────────────────────────────

export async function startDayPhase() {
  if (!STATE.isHost) return;
  const dayTimer = Date.now() + 3 * 60 * 1000;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    phase: "day",
    timerEnd: dayTimer,
  });
}

// ─── Phase: Voting (GM-triggered) ─────────────────────────────────────────────

export async function startVotingPhase() {
  if (!STATE.isHost) return;
  const voteTimer = Date.now() + 3 * 60 * 1000;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    phase: "voting",
    timerEnd: voteTimer,
  });
}

// ─── Force Announce Winner (GM override) ──────────────────────────────────────

export async function announceWinner(team) {
  if (!STATE.isHost) return;
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    status: "ended",
    phase: "result",
    winnerTeam: team,
  });
}

// ─── Win Condition ─────────────────────────────────────────────────────────────

export function checkWinCondition(players) {
  // Exclude GM from win condition calculation
  const alive = Object.values(players).filter(p => p.isAlive && p.role !== "gm");
  const wolfRoles = ["werewolf", "alpha_wolf", "dire_wolf", "lone_wolf", "mystic_wolf", "wolf_cub", "wolf_man"];
  const wolves = alive.filter(p => wolfRoles.includes(p.role));
  const villagers = alive.filter(p => !wolfRoles.includes(p.role));

  if (wolves.length === 0) return "villager";
  if (wolves.length >= villagers.length) return "werewolf";
  return null;
}

// ─── Timer (display-only, no auto-advance) ─────────────────────────────────────

let timerInterval = null;

export function startPhaseTimer(timerEnd, phase) {
  clearInterval(timerInterval);
  const el = document.getElementById("phase-timer");
  const votePanel = document.getElementById("vote-panel");

  if (!timerEnd) {
    if (el) { el.textContent = "--:--"; el.className = ""; }
    if (votePanel) votePanel.classList.remove("voting-urgent-pulse");
    return;
  }

  timerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.floor((timerEnd - Date.now()) / 1000));
    const min = Math.floor(remaining / 60).toString().padStart(2, "0");
    const sec = (remaining % 60).toString().padStart(2, "0");
    if (el) {
      el.textContent = `${min}:${sec}`;
      el.classList.toggle("timer-warning", remaining <= 15 && remaining > 5);
      el.classList.toggle("timer-critical", remaining <= 5);
    }

    // Urgent voting pulse
    if (votePanel && phase === "voting") {
      votePanel.classList.toggle("voting-urgent-pulse", remaining <= 15 && remaining > 0);
    } else if (votePanel) {
      votePanel.classList.remove("voting-urgent-pulse");
    }

    if (remaining <= 0) {
      clearInterval(timerInterval);
      if (el) el.textContent = "⏸";
      if (votePanel) votePanel.classList.remove("voting-urgent-pulse");
    }
  }, 1000);
}

export function stopPhaseTimer() {
  clearInterval(timerInterval);
}

// ─── Seer Private Data ────────────────────────────────────────────────────────

export async function getPrivateResult(key) {
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/privateData/${STATE.playerId}/${key}`));
  return snapshot.val();
}

// ─── Reset Room to Lobby ───────────────────────────────────────────────────────

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
