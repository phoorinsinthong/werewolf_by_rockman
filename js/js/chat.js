/**
 * chat.js — Real-time chat system
 * Channels: "global" (day), "werewolf" (wolves only, night), "dead" (dead players)
 */

import { ref, push, onValue } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { db, DB_PREFIX, STATE } from "./app.js";
import { getRoleConfig, ROLES } from "./game.js";

let chatUnsub = null;
let activeTab = "global";

// ─── Public API ────────────────────────────────────────────────────────────────

export function initChat() {
  // Wire chat send button and enter key
  const sendBtn = document.getElementById("btn-send-chat");
  const chatInput = document.getElementById("chat-input");
  if (sendBtn && !sendBtn._wired) {
    sendBtn._wired = true;
    sendBtn.addEventListener("click", handleSend);
  }
  if (chatInput && !chatInput._wired) {
    chatInput._wired = true;
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleSend();
    });
  }
  // Subscribe to global channel by default
  subscribeToChatTab("global");
  updateTabUI("global");
}

export function destroyChat() {
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
}

export async function sendMessage(text, type) {
  if (!text || !text.trim()) return;
  const chatRef = ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/chat`);
  await push(chatRef, {
    sender: STATE.playerName,
    senderId: STATE.playerId,
    message: text.trim(),
    type: type || "global",
    timestamp: Date.now(),
  });
}

export function setActiveChatTab(tab) {
  activeTab = tab;
  subscribeToChatTab(tab);
  updateTabUI(tab);
}

// ─── Tab Rendering ─────────────────────────────────────────────────────────────



function handleSend() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  // Determine which channel to post to based on active tab
  const me = STATE.roomData?.players?.[STATE.playerId];
  const myRole = me?.role;
  const isGM = myRole === "gm";
  let type = activeTab;

  // Gate posting based on role/status, unless GM
  if (!isGM) {
    if (type === "werewolf") {
      const cfg = STATE.roomData?.roleDeckCounts || {};
      const team = ROLES[myRole]?.team;
      if (team !== "werewolf") return;
    }
    if (type === "dead" && me?.isAlive !== false) return;
  }

  sendMessage(text, type);
  input.value = "";
}

function subscribeToChatTab(tab) {
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  const chatRef = ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/chat`);
  chatUnsub = onValue(chatRef, (snapshot) => {
    const data = snapshot.val() || {};
    const me = STATE.roomData?.players?.[STATE.playerId];
    const myRole = me?.role;
    const isAlive = me?.isAlive !== false;
    const isGM = myRole === "gm";

    // Filter by tab
    const messages = Object.values(data).filter(msg => {
      if (tab === "global") return msg.type === "global";
      if (tab === "werewolf") {
        const team = ROLES[myRole]?.team;
        return msg.type === "werewolf" && (team === "werewolf" || !isAlive || isGM);
      }
      if (tab === "dead") return msg.type === "dead" && (!isAlive || isGM);
      return false;
    });

    messages.sort((a, b) => (a.timestamp || 0)-(b.timestamp || 0));
    renderMessages(messages, tab);
  });
}

function renderMessages(messages, tab) {
  const container = document.getElementById("chat-messages");
  if (!messages.length) {
    container.innerHTML = `<div class="chat-empty">ยังไม่มีข้อความ เริ่มสนทนากันเลย!</div>`;
    return;
  }

  container.innerHTML = messages.map(msg => {
    const isMe = msg.senderId === STATE.playerId;
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    let channelBadge = "";
    if (tab === "werewolf") channelBadge = `<span class="chat-badge wolf-badge">🐺 หมาป่า</span>`;
    if (tab === "dead") channelBadge = `<span class="chat-badge dead-badge">💀 ผีสิง</span>`;
    return `
      <div class="chat-msg ${isMe ? "chat-msg-me" : "chat-msg-other"}">
        <div class="chat-msg-header">
          <span class="chat-sender">${escapeHtml(msg.sender)}</span>
          <span class="chat-time">${time}</span>
          ${channelBadge}
        </div>
        <div class="chat-bubble">${escapeHtml(msg.message)}</div>
      </div>`;
  }).join("");

  container.scrollTop = container.scrollHeight;
}

function updateTabUI(tab) {
  ["global", "wolf", "dead"].forEach(t => {
    const el = document.getElementById(`chat-tab-${t}`);
    const isActive = (t === tab) || (t === "wolf" && tab === "werewolf");
    if (el) el.classList.toggle("active", isActive);
  });

  // Show/hide wolf and dead tabs based on player status/team/GM
  const me = STATE.roomData?.players?.[STATE.playerId];
  const myRole = me?.role;
  const isGM = myRole === "gm";
  const wolfTab = document.getElementById("chat-tab-wolf");
  const deadTab = document.getElementById("chat-tab-dead");

  if (wolfTab) {
    // Show wolf tab if on werewolf team, or if GM
    const team = getRoleConfig(myRole).team;
    wolfTab.classList.toggle("hidden", team !== "werewolf" && !isGM);
  }
  if (deadTab) {
    // Show dead tab if dead, or if GM
    deadTab.classList.toggle("hidden", me?.isAlive !== false && !isGM);
  }
}

export function refreshChatTabs() {
  updateTabUI(activeTab);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
