/**
 * app.js — Application entry point
 * Firebase auth, state management, view routing, event bindings.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { FIREBASE_CONFIG, DB_PREFIX as _DB_PREFIX }
  from "./firebase-config.js";

// ─── Firebase Init ─────────────────────────────────────────────────────────────

const app  = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);
export const db   = getDatabase(app);
export const DB_PREFIX = _DB_PREFIX;

// ─── Global State ──────────────────────────────────────────────────────────────

export const STATE = {
  authUser:   null,
  playerId:   null,
  roomId:     null,
  roomData:   null,
  playerName: "",
  isHost:     false,
};

// ─── Imports ───────────────────────────────────────────────────────────────────

import {
  createRoom, joinRoom, leaveRoom, toggleReady,
  subscribeToRoom, reconnectToRoom, showView, resetState, persistSession,
  showEliminationBanner,
} from "./room.js";

import {
  startGame, startVotingPhase, startNightPhase, resetToLobby,
  gmAnnounceNightResult, announceWinner, resolveNight,
} from "./game.js";

import { castVote, resolveVotes, gmSkipVote } from "./voting.js";

// ─── App Init ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  showLoadingScreen(true);

  onAuthStateChanged(auth, (user) => {
    if (user) {
      STATE.authUser = user;
      STATE.playerId = user.uid;
      showLoadingScreen(false);
      tryReconnect();
    } else {
      signInAnonymously(auth).catch(err => {
        showLoadingScreen(false);
        showHomeError("การเชื่อมต่อล้มเหลว กรุณารีเฟรชหน้าเว็บ");
        console.error(err);
      });
    }
  });

  bindHomeEvents();
  bindLobbyEvents();
  bindGameEvents();
  bindGMEvents();
  bindResultEvents();
});

// ─── Reconnect ─────────────────────────────────────────────────────────────────

async function tryReconnect() {
  try {
    const saved = JSON.parse(localStorage.getItem("ww_session") || "null");
    if (saved?.roomId && saved?.playerId === STATE.playerId) {
      STATE.roomId     = saved.roomId;
      STATE.playerName = saved.playerName;
      STATE.isHost     = saved.isHost;

      const banner = document.getElementById("reconnect-banner");
      if (banner) {
        banner.classList.remove("hidden");
        const nameEl = banner.querySelector("#reconnect-room-code");
        if (nameEl) nameEl.textContent = saved.roomId;
      }
      showView("home"); // Show home with reconnect banner
      return;
    }
  } catch (_) {}
  showView("home"); // Show home by default
}

// ─── Home Events ───────────────────────────────────────────────────────────────

function bindHomeEvents() {
  document.getElementById("btn-create-room")?.addEventListener("click", async () => {
    const name = getPlayerName();
    if (!name) return;
    clearHomeError();
    try {
      await createRoom(name);
      persistSession();
    } catch (e) {
      showHomeError(e.message || "ไม่สามารถสร้างห้อง ลองใหม่");
    }
  });

  document.getElementById("btn-join-room")?.addEventListener("click", async () => {
    const name = getPlayerName();
    const code = document.getElementById("room-code-input")?.value.trim().toUpperCase();
    if (!name) return;
    if (!code || code.length < 4) { showHomeError("ใส่รหัสห้องให้ถูกต้อง"); return; }
    clearHomeError();
    try {
      await joinRoom(code, name);
      persistSession();
    } catch (e) {
      showHomeError(e.message || "ไม่สามารถเข้าร่วมห้อง ลองใหม่");
    }
  });

  document.getElementById("room-code-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-join-room")?.click();
  });
  document.getElementById("player-name-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-create-room")?.click();
  });
}

// ─── Lobby Events ──────────────────────────────────────────────────────────────

function bindLobbyEvents() {
  document.getElementById("btn-leave-lobby")?.addEventListener("click", async () => {
    await leaveRoom();
    clearSession();
  });

  document.getElementById("btn-ready")?.addEventListener("click", async () => {
    if (!STATE.isHost) await toggleReady();
  });

  document.getElementById("btn-start-game")?.addEventListener("click", async () => {
    if (STATE.isHost) await startGame();
  });

  // Copy room code
  document.getElementById("room-code-pill")?.addEventListener("click", () => {
    const code = STATE.roomId;
    if (code) {
      navigator.clipboard.writeText(code).then(() => {
        const pill = document.getElementById("room-code-pill");
        if (pill) {
          pill.style.background = "rgba(16,185,129,0.2)";
          setTimeout(() => { pill.style.background = ""; }, 1200);
        }
      });
    }
  });

  // Reconnect banner
  document.getElementById("btn-reconnect-yes")?.addEventListener("click", async () => {
    document.getElementById("reconnect-banner")?.classList.add("hidden");
    await reconnectToRoom();
  });
  document.getElementById("btn-reconnect-no")?.addEventListener("click", () => {
    document.getElementById("reconnect-banner")?.classList.add("hidden");
    clearSession();
    resetState();
  });
}

// ─── Game Events (player-side) ─────────────────────────────────────────────────

function bindGameEvents() {
  // Submit vote
  document.getElementById("btn-submit-vote")?.addEventListener("click", async () => {
    await castVote();
  });

  // Chat send
  document.getElementById("btn-send-chat")?.addEventListener("click", () => {
    window._sendChat?.();
  });
  document.getElementById("chat-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      window._sendChat?.();
    }
  });

  // Chat tabs
  document.querySelectorAll(".chat-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const ch = tab.dataset.channel;
      if (ch) window._switchChatTab?.(ch);
    });
  });
}

// ─── GM Events ────────────────────────────────────────────────────────────────

function bindGMEvents() {
  // Start night
  document.getElementById("gm-btn-to-night")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    await startNightPhase();
  });

  // Force resolve night (skip players who haven't submitted)
  document.getElementById("gm-btn-force-night")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    const room = STATE.roomData;
    if (room?.phase === "night") await resolveNight(room);
  });

  // Announce night result → move to day
  document.getElementById("gm-btn-announce-night")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    const room = STATE.roomData;
    if (room?.lastElimination) showEliminationBanner(room.lastElimination);
    await gmAnnounceNightResult();
  });

  // Start voting
  document.getElementById("gm-btn-to-vote")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    await startVotingPhase();
  });

  // Approve vote result (eliminate top-voted)
  document.getElementById("gm-btn-approve-vote")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    await resolveVotes();
  });

  // Skip vote (no elimination this round)
  document.getElementById("gm-btn-skip-vote")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    if (confirm("ข้ามรอบโหวต — ไม่กำจัดผู้เล่นรอบนี้?")) await gmSkipVote();
  });

  // Announce winner – villagers
  document.getElementById("gm-btn-winner-v")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    if (confirm("ประกาศ ชาวบ้านชนะ — แน่ใจหรือ?")) await announceWinner("villager");
  });

  // Announce winner – werewolves
  document.getElementById("gm-btn-winner-w")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    if (confirm("ประกาศ หมาป่าชนะ — แน่ใจหรือ?")) await announceWinner("werewolf");
  });

  // Announce winner – independent
  document.getElementById("gm-btn-winner-i")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    if (confirm("ประกาศ ฝ่ายอิสระชนะ — แน่ใจหรือ?")) await announceWinner("independent");
  });
}

// ─── Result Events ─────────────────────────────────────────────────────────────

function bindResultEvents() {
  document.getElementById("btn-reset-lobby")?.addEventListener("click", async () => {
    if (STATE.isHost) await resetToLobby();
  });
  document.getElementById("btn-leave-result")?.addEventListener("click", async () => {
    await leaveRoom();
    clearSession();
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getPlayerName() {
  const name = document.getElementById("player-name-input")?.value.trim();
  if (!name)         { showHomeError("กรอกชื่อของคุณก่อนนะ"); return null; }
  if (name.length < 2) { showHomeError("ชื่อต้องมีอย่างน้อย 2 ตัวอักษร"); return null; }
  if (name.length > 18) { showHomeError("ชื่อยาวเกินไป (สูงสุด 18 ตัวอักษร)"); return null; }
  STATE.playerName = name;
  return name;
}

function showHomeError(msg) {
  const el = document.getElementById("home-error");
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}
function clearHomeError() {
  const el = document.getElementById("home-error");
  if (el) el.classList.add("hidden");
}
function showLoadingScreen(show) {
  const el = document.getElementById("loading-overlay");
  if (el) el.classList.toggle("hidden", !show);
}
function clearSession() {
  try { localStorage.removeItem("ww_session"); } catch (_) {}
}
