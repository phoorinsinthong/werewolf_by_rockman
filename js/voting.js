/**
 * voting.js — Voting logic (GM approves result)
 * Players vote; GM presses "approve" to resolve and announce.
 */

import { ref, update, get } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { db, DB_PREFIX, STATE } from "./app.js";
import { checkWinCondition, getRoleConfig } from "./game.js";

// ─── Select Vote Target (player-triggered) ────────────────────────────────────

let selectedVoteTarget = null;

export function resetVoteSelection() {
  selectedVoteTarget = null;
}

window.selectVote = function (targetId) {
  const room = STATE.roomData;
  if (!room) return;
  const me = room.players?.[STATE.playerId];
  if (!me?.isAlive || me.vote) return;  // already voted
  selectedVoteTarget = targetId;
  renderVoting(room);
};

// ─── Cast Vote (player-triggered) ─────────────────────────────────────────────

export async function castVote() {
  if (!selectedVoteTarget) return;
  const me = STATE.roomData?.players?.[STATE.playerId];
  if (!me?.isAlive || me.vote) return;
  // Silenced or banned players cannot vote
  if (me.status?.silenced || me.status?.banned) return;

  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}`), {
    vote: selectedVoteTarget,
  });
}

// ─── Render Voting Grid ────────────────────────────────────────────────────────

export function renderVoting(roomData) {
  const grid      = document.getElementById("vote-grid");
  const submitBtn = document.getElementById("btn-submit-vote");
  if (!grid) return;

  const players     = roomData.players || {};
  const hostId      = roomData.hostId;
  const me          = players[STATE.playerId];

  if (roomData.inPersonMode) {
    grid.innerHTML = `<div class="night-waiting" style="padding: 20px; text-align: center; grid-column: 1 / -1;"><div style="font-size:3em; margin-bottom:10px;">👉</div><h3 style="color:var(--day-gold);">โหวตด้วยการชี้นิ้ว!</h3><p style="color:var(--text-muted); margin-top:8px;">โปรดใช้วิธีการชี้นิ้วเพื่อโหวต (ไม่ใช้มือถือ)<br>รอ GM สรุปผลการโหวตจากเสียงข้างมาก...</p></div>`;
    if (submitBtn) submitBtn.style.display = "none";
    const progressEl = document.getElementById("vote-progress");
    if (progressEl) progressEl.textContent = "โหมดเสมือนจริง";
    return;
  }

  if (submitBtn) submitBtn.style.display = "";

  const myVote      = me?.vote;
  const isSilenced  = me?.status?.silenced;
  const isBanned    = me?.status?.banned;
  const isRestricted = isSilenced || isBanned;

  // Alive, non-GM players eligible
  const alivePlayers = Object.entries(players)
    .filter(([, p]) => p.isAlive && p.role !== "gm");

  // Use mayor double-vote logic
  const voteTally = {};
  for (const [, p] of alivePlayers) {
    if (p.vote) {
      const voteWeight = p.role === "mayor" ? 2 : 1;
      voteTally[p.vote] = (voteTally[p.vote] || 0) + voteWeight;
    }
  }

  const totalVoters = alivePlayers.filter(([id]) => id !== STATE.playerId).length;
  const votesIn     = alivePlayers.filter(([, p]) => p.vote).length;

  const progressEl = document.getElementById("vote-progress");
  if (progressEl) progressEl.textContent = `${votesIn} / ${alivePlayers.length} คนโหวตแล้ว`;

  const hasVoted = !!myVote;

  // Dead players see everyone's votes revealed
  const isDead = !me?.isAlive;

  grid.innerHTML = alivePlayers
    .filter(([id]) => id !== STATE.playerId && id !== hostId)
    .map(([id, p]) => {
      const voteCount  = voteTally[id] || 0;
      const isSelected = selectedVoteTarget === id || myVote === id;
      const pct        = alivePlayers.length > 1 ? Math.round((voteCount / (alivePlayers.length - 1)) * 100) : 0;
      // Status badges
      const pStatus = p.status || {};
      let statusBadge = "";
      if (pStatus.silenced) statusBadge += `<span class="status-badge status-silenced">🤐 ใบ้</span>`;
      if (pStatus.banned) statusBadge += `<span class="status-badge status-banned">🚫 แบน</span>`;
      if (pStatus.lover) statusBadge += `<span class="status-badge status-lover">💘 คู่รัก</span>`;
      return `
        <button
          class="vote-card ${isSelected ? "vote-selected" : ""} ${hasVoted || isDead || isRestricted ? "vote-locked" : ""}"
          onclick="window.selectVote('${id}')"
          ${hasVoted || isDead || isRestricted ? "disabled" : ""}
          id="vote-card-${id}"
        >
          <div class="vote-avatar">${p.name.charAt(0).toUpperCase()}</div>
          <div class="vote-name">${escapeHtml(p.name)}</div>
          ${statusBadge ? `<div class="vote-status-badges">${statusBadge}</div>` : ""}
          <div class="vote-bar-wrap">
            <div class="vote-bar" style="width:${pct}%"></div>
          </div>
          <div class="vote-count">${voteCount} โหวต</div>
        </button>`;
    }).join("");

  if (submitBtn) {
    submitBtn.disabled = hasVoted || !selectedVoteTarget || isDead || isRestricted;
    const front = submitBtn.querySelector(".front") || submitBtn;
    if (isRestricted) {
      front.textContent = isSilenced ? "🤐 คุณถูกปิดปาก — โหวตไม่ได้" : "🚫 คุณถูกแบน — โหวตไม่ได้";
    } else {
      front.textContent = hasVoted ? "✅ โหวตแล้ว — รอ GM ประกาศ" : "ยืนยันการโหวต";
    }
  }
}

// ─── GM: Resolve Votes (approve result) ───────────────────────────────────────

export async function resolveVotes() {
  if (!STATE.isHost) return;
  const room = STATE.roomData;
  if (!room || room.phase !== "voting") return;

  const players      = room.players || {};
  const alivePlayers = Object.entries(players)
    .filter(([, p]) => p.isAlive && p.role !== "gm");

  // Mayor's vote counts as 2
  const voteTally = {};
  for (const [, p] of alivePlayers) {
    if (p.vote) {
      const voteWeight = p.role === "mayor" ? 2 : 1;
      voteTally[p.vote] = (voteTally[p.vote] || 0) + voteWeight;
    }
  }

  // Find player with most votes
  let topId    = null;
  let topVotes = 0;
  for (const [id, count] of Object.entries(voteTally)) {
    if (count > topVotes) { topVotes = count; topId = id; }
  }

  // Tie → no elimination
  const topIds = Object.entries(voteTally).filter(([, c]) => c === topVotes).map(([id]) => id);
  if (topIds.length > 1) topId = null;

  if (topId) {
    // Prince survives execution once
    const target = players[topId];
    if (target?.role === "prince" && !target?.status?.princeUsed) {
      await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${topId}/status`), { princeUsed: true });
      await clearVotes();
      await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
        phase:           "standby",
        timerEnd:        null,
        lastElimination: {
          playerId: topId, playerName: target.name, playerRole: target.role,
          reason: "prince_saved", timestamp: Date.now(),
        },
      });
    } else {
      await eliminatePlayer(topId, "vote", players[topId]);
    }
  } else {
    // Tie or no votes → no elimination, move to standby
    await clearVotes();
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      phase:           "standby",
      timerEnd:        null,
      lastElimination: {
        playerId: null, playerName: null, playerRole: null,
        reason: "tie", timestamp: Date.now(),
      },
    });
  }
}

// ─── GM: Skip Vote (no elimination) ───────────────────────────────────────────

export async function gmSkipVote() {
  if (!STATE.isHost) return;
  await clearVotes();
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    phase:    "standby",
    timerEnd: null,
    lastElimination: {
      playerId: null, playerName: null, playerRole: null,
      reason: "skipped", timestamp: Date.now(),
    },
  });
}

// ─── Eliminate Player ──────────────────────────────────────────────────────────

async function eliminatePlayer(playerId, reason, playerData) {
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${playerId}`), {
    isAlive: false,
  });
  const elim = {
    playerId,
    playerName: playerData?.name,
    playerRole: playerData?.role,
    reason,
    timestamp: Date.now(),
  };
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    lastElimination: elim,
  });
  await postEliminationFlow(playerId);
}

// ─── Post Elimination (win check → standby or end + lover death) ──────────────

async function postEliminationFlow(eliminatedId) {
  await clearVotes();
  
  // Check lover death (Cupid mechanic)
  const roomSnap = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`));
  const roomData = roomSnap.val() || {};
  const players  = roomData.players || {};
  const lovers   = roomData.lovers;
  
  if (lovers) {
    const { player1, player2 } = lovers;
    if (eliminatedId === player1 && players[player2]?.isAlive) {
      // Lover dies together
      await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${player2}`), { isAlive: false });
    } else if (eliminatedId === player2 && players[player1]?.isAlive) {
      // Lover dies together
      await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${player1}`), { isAlive: false });
    }
  }
  
  // Re-fetch players after potential lover death
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players`));
  const updatedPlayers = snapshot.val() || {};
  const winner   = checkWinCondition(updatedPlayers);

  if (winner) {
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      status:    "ended",
      phase:     "result",
      winnerTeam: winner,
    });
  } else {
    // Return to standby — GM will start next night
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      phase:    "standby",
      timerEnd: null,
    });
  }
}

// ─── Clear All Votes ───────────────────────────────────────────────────────────

async function clearVotes() {
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players`));
  const players  = snapshot.val() || {};
  const clears   = {};
  for (const id of Object.keys(players)) {
    clears[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/vote`] = "";
  }
  if (Object.keys(clears).length) await update(ref(db), clears);
  selectedVoteTarget = null;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
