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
  const myVote      = me?.vote;

  // Alive, non-GM players eligible
  const alivePlayers = Object.entries(players)
    .filter(([, p]) => p.isAlive && p.role !== "gm");

  const voteTally = {};
  for (const [, p] of alivePlayers) {
    if (p.vote) voteTally[p.vote] = (voteTally[p.vote] || 0) + 1;
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
      return `
        <button
          class="vote-card ${isSelected ? "vote-selected" : ""} ${hasVoted || isDead ? "vote-locked" : ""}"
          onclick="window.selectVote('${id}')"
          ${hasVoted || isDead ? "disabled" : ""}
          id="vote-card-${id}"
        >
          <div class="vote-avatar">${p.name.charAt(0).toUpperCase()}</div>
          <div class="vote-name">${escapeHtml(p.name)}</div>
          <div class="vote-bar-wrap">
            <div class="vote-bar" style="width:${pct}%"></div>
          </div>
          <div class="vote-count">${voteCount} โหวต</div>
        </button>`;
    }).join("");

  if (submitBtn) {
    submitBtn.disabled = hasVoted || !selectedVoteTarget || isDead;
    submitBtn.querySelector(".front").textContent = hasVoted ? "✅ โหวตแล้ว — รอ GM ประกาศ" : "ยืนยันการโหวต";
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

  const voteTally = {};
  for (const [, p] of alivePlayers) {
    if (p.vote) voteTally[p.vote] = (voteTally[p.vote] || 0) + 1;
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
    await eliminatePlayer(topId, "vote", players[topId]);
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

// ─── Post Elimination (win check → standby or end) ────────────────────────────

async function postEliminationFlow(eliminatedId) {
  await clearVotes();
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players`));
  const players  = snapshot.val() || {};
  const winner   = checkWinCondition(players);

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
