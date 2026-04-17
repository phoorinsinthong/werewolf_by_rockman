/**
 * app.js — Application entry point
 * Firebase init, anonymous auth, STATE, view routing, event binding
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getDatabase, ref, update } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig, DB_PREFIX } from "./firebase-config.js";
import { createRoom, joinRoom, leaveRoom } from "./room.js";
import { startGame, startVotingPhase, resetToLobby } from "./game.js";
import { castVote, resolveVotes } from "./voting.js";
import { setActiveChatTab } from "./chat.js";

// ─── Firebase Init ─────────────────────────────────────────────────────────────

const firebaseApp = initializeApp(firebaseConfig);
export const db = getDatabase(firebaseApp);
const auth = getAuth(firebaseApp);

// ─── STATE ─────────────────────────────────────────────────────────────────────

export const STATE = {
  playerId: null,
  playerName: "",
  roomId: null,
  roomData: null,
  isHost: false,
  _lastTimerEnd: null,
};

export { DB_PREFIX };

// ─── View Management ───────────────────────────────────────────────────────────

const VIEWS = ["home", "lobby", "game", "result"];

export function showView(name) {
  VIEWS.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.toggle("hidden", v !== name);
  });
}

// ─── Auth Init ────────────────────────────────────────────────────────────────

function initAuth() {
  showLoadingScreen(true);
  onAuthStateChanged(auth, (user) => {
    if (user) {
      STATE.playerId = user.uid;
      showLoadingScreen(false);
      checkReconnect();
    } else {
      signInAnonymously(auth).catch(err => {
        showLoadingScreen(false);
        showHomeError("การเชื่อมต่อล้มเหลว กรุณารีเฟรชหน้าเว็บ");
        console.error(err);
      });
    }
  });
}

function showLoadingScreen(show) {
  const el = document.getElementById("loading-overlay");
  if (el) el.classList.toggle("hidden", !show);
}

// ─── Reconnect Logic ──────────────────────────────────────────────────────────

function checkReconnect() {
  const savedRoom = sessionStorage.getItem("ww_roomId");
  const savedName = sessionStorage.getItem("ww_name");
  if (savedRoom && savedName) {
    const reconnectEl = document.getElementById("reconnect-banner");
    if (reconnectEl) {
      reconnectEl.classList.remove("hidden");
      document.getElementById("reconnect-room").textContent = savedRoom;
      document.getElementById("btn-reconnect").onclick = async () => {
        reconnectEl.classList.add("hidden");
        try {
          STATE.playerName = savedName;
          await joinRoom(savedRoom, savedName);
        } catch {
          sessionStorage.removeItem("ww_roomId");
          sessionStorage.removeItem("ww_name");
        }
      };
      document.getElementById("btn-reconnect-cancel").onclick = () => {
        reconnectEl.classList.add("hidden");
        sessionStorage.removeItem("ww_roomId");
        sessionStorage.removeItem("ww_name");
      };
    }
  }
  showView("home");
}

// ─── Event Listeners ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initAuth();
  bindHomeEvents();
  bindLobbyEvents();
  bindGameEvents();
  bindResultEvents();

  // Copy room code
  document.querySelectorAll(".copy-code-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(STATE.roomId || "").then(() => {
        btn.textContent = "✅";
        setTimeout(() => btn.textContent = "📋", 1500);
      });
    });
  });
});

// ─── Home ─────────────────────────────────────────────────────────────────────

function bindHomeEvents() {
  document.getElementById("btn-create-room").addEventListener("click", async () => {
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

  document.getElementById("btn-join-room").addEventListener("click", async () => {
    const name = getPlayerName();
    const code = document.getElementById("room-code-input").value.trim().toUpperCase();
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

  // Allow Enter to join
  document.getElementById("room-code-input").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("btn-join-room").click();
  });
  document.getElementById("player-name-input").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("btn-create-room").click();
  });
}

function getPlayerName() {
  const name = document.getElementById("player-name-input").value.trim();
  if (!name) { showHomeError("กรอกชื่อของคุณก่อนนะ"); return null; }
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

function persistSession() {
  sessionStorage.setItem("ww_roomId", STATE.roomId);
  sessionStorage.setItem("ww_name", STATE.playerName);
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

function bindLobbyEvents() {
  // Leave room
  document.getElementById("btn-leave-room").addEventListener("click", () => {
    document.getElementById("leave-modal").classList.remove("hidden");
  });
  document.getElementById("btn-leave-cancel").addEventListener("click", () => {
    document.getElementById("leave-modal").classList.add("hidden");
  });
  document.getElementById("btn-leave-confirm").addEventListener("click", async () => {
    document.getElementById("leave-modal").classList.add("hidden");
    sessionStorage.clear();
    await leaveRoom();
  });

  // Ready toggle
  document.getElementById("btn-ready").addEventListener("click", async () => {
    const me = STATE.roomData?.players?.[STATE.playerId];
    if (!me) return;
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}`), {
      isReady: !me.isReady,
    });
  });

  // Start game (host)
  document.getElementById("btn-start-game").addEventListener("click", async () => {
    await startGame();
  });
}

// ─── Game ─────────────────────────────────────────────────────────────────────

function bindGameEvents() {
  // Leave game
  document.getElementById("btn-leave-game").addEventListener("click", () => {
    document.getElementById("leave-modal-game").classList.remove("hidden");
  });
  document.getElementById("btn-leave-game-cancel").addEventListener("click", () => {
    document.getElementById("leave-modal-game").classList.add("hidden");
  });
  document.getElementById("btn-leave-game-confirm").addEventListener("click", async () => {
    document.getElementById("leave-modal-game").classList.add("hidden");
    sessionStorage.clear();
    await leaveRoom();
  });

  // Submit vote
  document.getElementById("btn-submit-vote").addEventListener("click", async () => {
    const me = STATE.roomData?.players?.[STATE.playerId];
    if (me?.vote) return; // Already voted
    // Find selected vote card
    const selected = document.querySelector(".vote-card.vote-selected");
    if (!selected) return;
    const targetId = selected.id.replace("vote-card-", "");
    await castVote(targetId);
  });

  // Force resolve votes (host)
  document.getElementById("btn-force-resolve").addEventListener("click", async () => {
    if (STATE.isHost) await resolveVotes();
  });

  // Host start voting (day phase)
  document.getElementById("host-start-vote").addEventListener("click", async () => {
    if (STATE.isHost) await startVotingPhase();
  });

  // Chat tabs — delegate to chat.js
  document.getElementById("chat-tab-global").addEventListener("click", () => setActiveChatTab("global"));
  document.getElementById("chat-tab-wolf").addEventListener("click", () => setActiveChatTab("werewolf"));
  document.getElementById("chat-tab-dead").addEventListener("click", () => setActiveChatTab("dead"));
}

// ─── Result ───────────────────────────────────────────────────────────────────

function bindResultEvents() {
  document.getElementById("btn-play-again").addEventListener("click", async () => {
    sessionStorage.removeItem("ww_roomId");
    await resetToLobby();
  });

  document.getElementById("btn-result-home").addEventListener("click", async () => {
    sessionStorage.clear();
    await leaveRoom();
  });
}
