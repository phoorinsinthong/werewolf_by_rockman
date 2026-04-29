/**
 * app.js — Application entry point
 * Firebase auth, state management, view routing, event bindings.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { ref, get, remove } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
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
  approveNightAction, rejectNightAction
} from "./game.js";

import { castVote, resolveVotes, gmSkipVote } from "./voting.js";

// ─── App Init ──────────────────────────────────────────────────────────────────

let _authReady = false; // Tracks if initial auth has completed

document.addEventListener("DOMContentLoaded", () => {
  showLoadingScreen(true);

  // Safety timeout in case Firebase Auth gets stuck due to network/cache
  const authTimeout = setTimeout(() => {
    showLoadingScreen(false);
    showView("home"); // Show home so user can see the error banner
    showHomeError("การเชื่อมต่อเซิร์ฟเวอร์ล่าช้า กรุณาตรวจสอบอินเทอร์เน็ตหรือบังคับรีเฟรช (Ctrl+F5)");
  }, 8000);

  onAuthStateChanged(auth, (user) => {
    clearTimeout(authTimeout);
    if (user) {
      STATE.authUser = user;
      STATE.playerId = user.uid;
      showLoadingScreen(false);
      // Only run reconnect on FIRST auth event
      // Subsequent auth events (e.g. token refresh after screen lock) should not reset the UI
      if (!_authReady) {
        _authReady = true;
        tryReconnect();
      }
    } else {
      signInAnonymously(auth).catch(err => {
        showLoadingScreen(false);
        showView("home"); // Ensure home view is visible to show error
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
  bindModalEvents();
  bindAdminEvents();
  bindVisibilityHandler();
});

// ─── Reconnect ─────────────────────────────────────────────────────────────────

async function tryReconnect() {
  try {
    const saved = JSON.parse(localStorage.getItem("ww_session") || "null");
    if (saved?.roomId && saved?.playerId === STATE.playerId) {
      STATE.roomId     = saved.roomId;
      STATE.playerName = saved.playerName;
      STATE.isHost     = saved.isHost;

      // Auto-reconnect: directly re-subscribe instead of showing banner
      try {
        await reconnectToRoom();
        console.log("[WW] Auto-reconnected to room", saved.roomId);
        return;
      } catch (err) {
        console.warn("[WW] Auto-reconnect failed, showing banner", err);
      }

      // Fallback: show reconnect banner if auto-reconnect failed
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

// ─── Visibility & Wake-up Handler ──────────────────────────────────────────────
// When mobile screen locks/unlocks or tab goes to background/foreground,
// Firebase WebSocket may disconnect. This handler re-establishes the subscription.

function bindVisibilityHandler() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      handleAppWakeUp();
    }
  });

  // Also handle page focus (some mobile browsers use this instead)
  window.addEventListener("focus", () => {
    handleAppWakeUp();
  });
}

let _lastWakeUp = 0;
async function handleAppWakeUp() {
  // Debounce: don't run more than once per 3 seconds
  const now = Date.now();
  if (now - _lastWakeUp < 3000) return;
  _lastWakeUp = now;

  // If we're in a room, verify we're still connected and re-subscribe if needed
  if (!STATE.roomId || !STATE.playerId) return;

  console.log("[WW] App woke up, verifying room connection...");

  try {
    // Check if our player still exists in the room
    const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}`));
    if (!snapshot.exists()) {
      // Room or player was deleted while we were asleep
      const roomSnap = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`));
      if (!roomSnap.exists()) {
        console.log("[WW] Room no longer exists");
        clearSession();
        resetState();
        showView("home");
        return;
      }
      // Room exists but player was removed — try to re-add if we have session
      console.log("[WW] Player removed from room, attempting to re-join...");
      const saved = JSON.parse(localStorage.getItem("ww_session") || "null");
      if (saved?.roomId === STATE.roomId) {
        await reconnectToRoom();
      }
      return;
    }

    // Player exists — re-subscribe to keep the listener fresh
    console.log("[WW] Still in room, refreshing subscription");
    subscribeToRoom();
  } catch (err) {
    console.warn("[WW] Wake-up check failed:", err);
  }
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
  document.getElementById("btn-leave-room")?.addEventListener("click", () => {
    document.getElementById("leave-modal")?.classList.remove("hidden");
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
  document.getElementById("btn-leave-game")?.addEventListener("click", () => {
      document.getElementById("leave-modal-game")?.classList.remove("hidden");
  });

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

  // Manual Role Card Flip
  document.getElementById("role-card")?.addEventListener("click", () => {
    document.getElementById("role-card-container")?.classList.toggle("highlight-flip");
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

  // Night turn approval
  document.getElementById("gm-btn-approve-action")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    await approveNightAction();
  });
  document.getElementById("gm-btn-reject-action")?.addEventListener("click", async () => {
    if (!STATE.isHost) return;
    if (confirm("ต้องการปฏิเสธเป้าหมายนี้ และให้ผู้เล่นเลือกใหม่ใช่หรือไม่?")) {
      await rejectNightAction();
    }
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

// ─── Modal Bindings ────────────────────────────────────────────────────────────

function bindModalEvents() {
  // Lobby Leave Modal
  document.getElementById("btn-leave-confirm")?.addEventListener("click", async () => {
    document.getElementById("leave-modal")?.classList.add("hidden");
    await leaveRoom();
    clearSession();
  });
  document.getElementById("btn-leave-cancel")?.addEventListener("click", () => {
    document.getElementById("leave-modal")?.classList.add("hidden");
  });

  // Game Leave Modal
  document.getElementById("btn-leave-game-confirm")?.addEventListener("click", async () => {
    document.getElementById("leave-modal-game")?.classList.add("hidden");
    await leaveRoom();
    clearSession();
  });
  document.getElementById("btn-leave-game-cancel")?.addEventListener("click", () => {
    document.getElementById("leave-modal-game")?.classList.add("hidden");
  });
}

function clearSession() {
  try { localStorage.removeItem("ww_session"); } catch (_) {}
}

// ─── Admin Panel ───────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = "admin";

function bindAdminEvents() {
  // Open admin modal
  document.getElementById("btn-open-admin")?.addEventListener("click", () => {
    openAdminModal();
  });

  // Close admin modal
  document.getElementById("btn-admin-close")?.addEventListener("click", () => {
    closeAdminModal();
  });

  // Login with password
  document.getElementById("btn-admin-login")?.addEventListener("click", () => {
    adminLogin();
  });

  // Enter key on password input
  document.getElementById("admin-password-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") adminLogin();
  });

  // Reset all rooms button
  document.getElementById("btn-admin-reset-all")?.addEventListener("click", () => {
    showAdminStep("confirm");
  });

  // Back to password
  document.getElementById("btn-admin-back")?.addEventListener("click", () => {
    closeAdminModal();
  });

  // Confirm reset
  document.getElementById("btn-admin-confirm-reset")?.addEventListener("click", async () => {
    await adminResetAllRooms();
  });

  // Cancel reset
  document.getElementById("btn-admin-cancel-reset")?.addEventListener("click", () => {
    showAdminStep("rooms");
    adminLoadRooms();
  });

  // Done (success)
  document.getElementById("btn-admin-done")?.addEventListener("click", () => {
    closeAdminModal();
  });
}

function openAdminModal() {
  const modal = document.getElementById("admin-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  showAdminStep("password");
  const pwInput = document.getElementById("admin-password-input");
  if (pwInput) { pwInput.value = ""; pwInput.focus(); }
  document.getElementById("admin-password-error")?.classList.add("hidden");
}

function closeAdminModal() {
  document.getElementById("admin-modal")?.classList.add("hidden");
}

function showAdminStep(step) {
  ["password", "rooms", "confirm", "success"].forEach(s => {
    const el = document.getElementById(`admin-step-${s}`);
    if (el) el.classList.toggle("hidden", s !== step);
  });
}

function adminLogin() {
  const pw = document.getElementById("admin-password-input")?.value || "";
  if (pw === ADMIN_PASSWORD) {
    showAdminStep("rooms");
    adminLoadRooms();
  } else {
    const errEl = document.getElementById("admin-password-error");
    if (errEl) {
      errEl.classList.remove("hidden");
      // Re-trigger shake animation
      errEl.style.animation = "none";
      errEl.offsetHeight; // Force reflow
      errEl.style.animation = "shake 0.3s ease";
    }
  }
}

async function adminLoadRooms() {
  const listEl = document.getElementById("admin-room-list");
  if (!listEl) return;

  listEl.innerHTML = `
    <div class="admin-room-loading">
      <div class="spinner-ring" style="width:32px;height:32px;position:relative;margin:0 auto 10px;"></div>
      <span>กำลังโหลด...</span>
    </div>`;

  try {
    const snapshot = await get(ref(db, `${DB_PREFIX}/rooms`));
    if (!snapshot.exists()) {
      listEl.innerHTML = `
        <div class="admin-room-empty">
          <span class="empty-icon">🏚️</span>
          <div>ไม่มีห้องที่เปิดอยู่ในระบบ</div>
        </div>`;
      document.getElementById("btn-admin-reset-all")?.setAttribute("disabled", "");
      return;
    }

    const rooms = snapshot.val();
    const roomIds = Object.keys(rooms);
    document.getElementById("btn-admin-reset-all")?.removeAttribute("disabled");

    if (roomIds.length === 0) {
      listEl.innerHTML = `
        <div class="admin-room-empty">
          <span class="empty-icon">🏚️</span>
          <div>ไม่มีห้องที่เปิดอยู่ในระบบ</div>
        </div>`;
      document.getElementById("btn-admin-reset-all")?.setAttribute("disabled", "");
      return;
    }

    const statusLabels = {
      waiting: { text: "⏳ รอผู้เล่น", cls: "admin-status-waiting" },
      playing: { text: "🎮 กำลังเล่น", cls: "admin-status-playing" },
      ended:   { text: "🏁 จบแล้ว",   cls: "admin-status-ended" },
    };

    listEl.innerHTML = roomIds.map((roomId, i) => {
      const room = rooms[roomId];
      const players = room.players ? Object.keys(room.players) : [];
      const status = room.status || "waiting";
      const statusInfo = statusLabels[status] || statusLabels.waiting;
      const hostName = room.players?.[room.hostId]?.name || "—";
      const createdAt = room.createdAt ? new Date(room.createdAt).toLocaleString("th-TH", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
      }) : "—";

      return `
        <div class="admin-room-item" style="animation-delay: ${i * 0.05}s;">
          <div class="admin-room-info">
            <div class="admin-room-code">${roomId}</div>
            <div class="admin-room-meta">
              <span class="admin-player-count">👥 ${players.length} คน</span>
              <span>GM: ${escapeHtmlAdmin(hostName)}</span>
              <span>·</span>
              <span>${createdAt}</span>
            </div>
          </div>
          <span class="admin-status-badge ${statusInfo.cls}">${statusInfo.text}</span>
        </div>`;
    }).join("");

  } catch (err) {
    console.error("Admin load rooms error:", err);
    listEl.innerHTML = `
      <div class="admin-room-empty">
        <span class="empty-icon">❌</span>
        <div>โหลดข้อมูลไม่สำเร็จ: ${err.message}</div>
      </div>`;
  }
}

async function adminResetAllRooms() {
  try {
    await remove(ref(db, `${DB_PREFIX}/rooms`));
    showAdminStep("success");
    // Also clear local session if the user was in a room
    clearSession();
  } catch (err) {
    console.error("Admin reset error:", err);
    alert("เกิดข้อผิดพลาด: " + err.message);
  }
}

function escapeHtmlAdmin(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
