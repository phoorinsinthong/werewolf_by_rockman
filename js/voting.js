/**
 * voting.js — Day voting system
 * Collect votes, real-time tally, elimination, tie handling
 */

import { ref, update, get } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { db, DB_PREFIX, STATE } from "./app.js";
import { checkWinCondition } from "./game.js";

// ─── Vote Casting ──────────────────────────────────────────────────────────────

export async function castVote(targetId) {
  const me = STATE.roomData?.players?.[STATE.playerId];
  if (!me?.isAlive) return; // Dead can't vote
  if (STATE.roomData?.phase !== "voting") return;

  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${STATE.playerId}`), {
    vote: targetId,
  });
}

export async function clearVotes() {
  const players = STATE.roomData?.players || {};
  const updates = {};
  for (const id of Object.keys(players)) {
    updates[`${DB_PREFIX}/rooms/${STATE.roomId}/players/${id}/vote`] = "";
  }
  await update(ref(db), updates);
}

// ─── Vote Resolution ───────────────────────────────────────────────────────────

export async function resolveVotes() {
  if (!STATE.isHost) return; // Only host resolves
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players`));
  const players = snapshot.val() || {};

  const alivePlayers = Object.entries(players).filter(([, p]) => p.isAlive);
  const voteTally = {};

  for (const [, p] of alivePlayers) {
    if (p.vote) {
      voteTally[p.vote] = (voteTally[p.vote] || 0) + 1;
    }
  }

  // Find max vote count
  const maxVotes = Math.max(0, ...Object.values(voteTally));
  const topTargets = Object.entries(voteTally)
    .filter(([, count]) => count === maxVotes)
    .map(([id]) => id);

  let eliminatedId = null;

  if (topTargets.length === 1) {
    // Clear winner
    eliminatedId = topTargets[0];
  } else if (topTargets.length > 1) {
    // Tie — random tiebreak
    eliminatedId = topTargets[Math.floor(Math.random() * topTargets.length)];
  }

  if (eliminatedId && players[eliminatedId]?.isAlive) {
    await eliminatePlayer(eliminatedId, "vote");
  } else {
    // No elimination (no votes cast)
    await postEliminationFlow(null);
  }
}

export async function eliminatePlayer(playerId, reason) {
  const players = STATE.roomData?.players || {};
  const playerName = players[playerId]?.name || "Unknown";
  const playerRole = players[playerId]?.role || "?";

  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players/${playerId}`), {
    isAlive: false,
    vote: "",
  });

  // Write elimination event for announcement
  await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
    lastElimination: {
      playerId,
      playerName,
      playerRole,
      reason, // "vote" | "werewolf"
      timestamp: Date.now(),
    },
  });

  await postEliminationFlow(playerId);
}

async function postEliminationFlow(eliminatedId) {
  // Clear votes
  await clearVotes();

  // Check win condition
  const snapshot = await get(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}/players`));
  const players = snapshot.val() || {};
  const winner = checkWinCondition(players);

  if (winner) {
    await update(ref(db, `${DB_PREFIX}/rooms/${STATE.roomId}`), {
      status: "ended",
      phase: "result",
      winnerTeam: winner,
    });
  } else {
    // Move to night
    const { startNightPhase } = await import("./game.js");
    await startNightPhase();
  }
}

// ─── Vote Rendering ────────────────────────────────────────────────────────────

let selectedVoteTarget = null;

export function renderVoting(roomData) {
  const players = roomData.players || {};
  const alivePlayers = Object.entries(players).filter(([, p]) => p.isAlive);
  const me = players[STATE.playerId];

  const grid = document.getElementById("vote-grid");
  if (!grid) return;

  // Show vote tally
  const voteTally = {};
  let myVote = me?.vote || null;

  for (const [, p] of alivePlayers) {
    if (p.vote) voteTally[p.vote] = (voteTally[p.vote] || 0) + 1;
  }
  const totalVoters = alivePlayers.length;
  const votesIn = alivePlayers.filter(([, p]) => p.vote).length;

  document.getElementById("vote-progress").textContent = `${votesIn} / ${totalVoters} คนโหวตแล้ว`;

  // Lock voting if already voted
  const hasVoted = !!myVote;

  grid.innerHTML = alivePlayers
    .filter(([id]) => id !== STATE.playerId)
    .map(([id, p]) => {
      const voteCount = voteTally[id] || 0;
      const isSelected = selectedVoteTarget === id || myVote === id;
      const pct = totalVoters > 1 ? Math.round((voteCount / (totalVoters - 1)) * 100) : 0;
      return `
        <button
          class="vote-card ${isSelected ? "vote-selected" : ""} ${hasVoted ? "vote-locked" : ""}"
          onclick="window.selectVote('${id}')"
          ${hasVoted ? "disabled" : ""}
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

  const submitBtn = document.getElementById("btn-submit-vote");
  if (submitBtn) {
    submitBtn.disabled = hasVoted || !selectedVoteTarget;
    submitBtn.querySelector(".front").textContent = hasVoted ? "✅ โหวตแล้ว" : "ยืนยันการโหวต";
  }

  // Host "Force Resolve" button
  const forceBtn = document.getElementById("btn-force-resolve");
  if (forceBtn) forceBtn.classList.toggle("hidden", !STATE.isHost);
}

window.selectVote = function (targetId) {
  if (STATE.roomData?.players?.[STATE.playerId]?.vote) return; // already voted
  selectedVoteTarget = targetId;
  renderVoting(STATE.roomData);
};

export function resetVoteSelection() {
  selectedVoteTarget = null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
