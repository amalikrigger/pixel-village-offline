"use strict";

(function main() {
  const STORAGE_KEY = "clashLaneCampaign.save.v1";
  const canvas = document.getElementById("battlefield");
  const context = canvas.getContext("2d");

  const ui = {
    levelName: document.getElementById("levelName"),
    elixirValue: document.getElementById("elixirValue"),
    timeValue: document.getElementById("timeValue"),
    selectedLane: document.getElementById("selectedLane"),
    selectedCard: document.getElementById("selectedCard"),
    playerKingHp: document.getElementById("playerKingHp"),
    enemyKingHp: document.getElementById("enemyKingHp"),
    statusText: document.getElementById("statusText"),
    cardBar: document.getElementById("cardBar"),
    campaignButtons: document.getElementById("campaignButtons"),
    startBtn: document.getElementById("startBtn"),
    resetBtn: document.getElementById("resetBtn")
  };

  const characters = window.GAME_CHARACTERS || [];
  const levels = window.GAME_LEVELS || [];
  const charById = new Map(characters.map((character) => [character.id, character]));

  if (!characters.length || !levels.length) {
    ui.statusText.textContent = "Missing character/level config.";
    return;
  }

  const laneCenters = [100, 250, 400];
  const unitRadius = 14;

  const state = {
    selectedLevelId: 1,
    unlockedLevel: 1,
    selectedLane: null,
    selectedCardId: characters[0].id,
    running: false,
    ended: false,
    winner: null,
    elapsed: 0,
    playerElixir: 5,
    enemyElixir: 5,
    enemySpawnTimer: 0,
    playerKingHp: 0,
    enemyKingHp: 0,
    units: [],
    nextUnitId: 1,
    lastFrameAt: performance.now(),
    coins: 0
  };

  function loadProgress() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (Number.isFinite(parsed.unlockedLevel)) {
        state.unlockedLevel = Math.max(1, Math.min(levels.length, parsed.unlockedLevel));
      }
      if (Number.isFinite(parsed.coins)) {
        state.coins = Math.max(0, parsed.coins);
      }
    } catch {
      state.unlockedLevel = 1;
      state.coins = 0;
    }
  }

  function saveProgress() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        unlockedLevel: state.unlockedLevel,
        coins: state.coins
      })
    );
  }

  function getSelectedLevel() {
    return levels.find((level) => level.id === state.selectedLevelId) || levels[0];
  }

  function spawnUnit(side, lane, characterId) {
    const template = charById.get(characterId);
    if (!template) {
      return;
    }

    state.units.push({
      id: state.nextUnitId++,
      side,
      lane,
      characterId,
      hp: template.hp,
      attackCd: 0,
      x: side === "player" ? 120 : canvas.width - 120,
      y: laneCenters[lane]
    });
  }

  function canAfford(cardId) {
    const card = charById.get(cardId);
    return card && state.playerElixir >= card.cost;
  }

  function placePlayerUnit() {
    if (!state.running || state.ended) {
      return;
    }
    if (state.selectedLane === null) {
      ui.statusText.textContent = "Pick a lane first.";
      return;
    }

    const card = charById.get(state.selectedCardId);
    if (!card) {
      return;
    }
    if (!canAfford(card.id)) {
      ui.statusText.textContent = "Not enough elixir.";
      return;
    }

    state.playerElixir -= card.cost;
    spawnUnit("player", state.selectedLane, card.id);
    ui.statusText.textContent = `${card.name} deployed in lane ${state.selectedLane + 1}.`;
  }

  function enemyChooseSpawn(level) {
    const candidates = level.enemyRoster
      .map((id) => charById.get(id))
      .filter(Boolean)
      .sort((a, b) => a.cost - b.cost);

    const affordable = candidates.filter((candidate) => candidate.cost <= state.enemyElixir);
    if (!affordable.length) {
      return;
    }

    const pick = affordable[Math.floor(Math.random() * affordable.length)];
    const lane = Math.floor(Math.random() * 3);
    state.enemyElixir -= pick.cost;
    spawnUnit("enemy", lane, pick.id);
  }

  function clampElixir() {
    state.playerElixir = Math.max(0, Math.min(10, state.playerElixir));
    state.enemyElixir = Math.max(0, Math.min(10, state.enemyElixir));
  }

  function updateCombat(deltaSeconds) {
    for (const unit of state.units) {
      unit.attackCd = Math.max(0, unit.attackCd - deltaSeconds);
      const profile = charById.get(unit.characterId);
      if (!profile) {
        continue;
      }

      const direction = unit.side === "player" ? 1 : -1;
      const enemies = state.units.filter(
        (candidate) => candidate.side !== unit.side && candidate.lane === unit.lane && candidate.hp > 0
      );

      let target = null;
      let minDistance = Number.POSITIVE_INFINITY;

      for (const enemy of enemies) {
        const distance = Math.abs(enemy.x - unit.x);
        if (distance < minDistance) {
          minDistance = distance;
          target = enemy;
        }
      }

      if (target && minDistance <= profile.range) {
        if (unit.attackCd <= 0) {
          target.hp -= profile.damage;
          unit.attackCd = profile.attackCooldown;
        }
        continue;
      }

      const enemyTowerX = unit.side === "player" ? canvas.width - 75 : 75;
      const towerDistance = Math.abs(enemyTowerX - unit.x);

      if (towerDistance <= profile.range) {
        if (unit.attackCd <= 0) {
          if (unit.side === "player") {
            state.enemyKingHp -= profile.damage;
          } else {
            state.playerKingHp -= profile.damage;
          }
          unit.attackCd = profile.attackCooldown;
        }
        continue;
      }

      unit.x += profile.speed * direction * deltaSeconds;
    }

    state.units = state.units.filter(
      (unit) =>
        unit.hp > 0 &&
        unit.x > 40 &&
        unit.x < canvas.width - 40 &&
        state.playerKingHp > 0 &&
        state.enemyKingHp > 0
    );
  }

  function checkEnd(level) {
    if (state.enemyKingHp <= 0 || state.playerKingHp <= 0 || state.elapsed >= level.duration) {
      state.ended = true;
      state.running = false;
      if (state.enemyKingHp <= 0 || state.enemyKingHp > state.playerKingHp) {
        state.winner = "player";
      } else {
        state.winner = "enemy";
      }

      if (state.winner === "player") {
        state.coins += level.rewardCoins;
        if (state.selectedLevelId >= state.unlockedLevel) {
          state.unlockedLevel = Math.min(levels.length, state.selectedLevelId + 1);
        }
        ui.statusText.textContent = `Victory! +${level.rewardCoins} coins.`;
      } else {
        ui.statusText.textContent = "Defeat. Try again with better lane timing.";
      }

      saveProgress();
      renderCampaignButtons();
    }
  }

  function tick(now) {
    const deltaSeconds = Math.min(0.05, (now - state.lastFrameAt) / 1000);
    state.lastFrameAt = now;

    if (state.running && !state.ended) {
      const level = getSelectedLevel();
      state.elapsed += deltaSeconds;
      state.playerElixir += 1.2 * deltaSeconds;
      state.enemyElixir += level.enemyElixirPerSecond * deltaSeconds;
      clampElixir();

      state.enemySpawnTimer += deltaSeconds * 1000;
      if (state.enemySpawnTimer >= level.spawnIntervalMs) {
        state.enemySpawnTimer = 0;
        enemyChooseSpawn(level);
      }

      updateCombat(deltaSeconds);
      checkEnd(level);
    }

    draw();
    refreshHud();
    requestAnimationFrame(tick);
  }

  function drawLanes() {
    context.strokeStyle = "rgba(255,255,255,0.2)";
    context.lineWidth = 2;
    for (const laneY of laneCenters) {
      context.beginPath();
      context.moveTo(0, laneY);
      context.lineTo(canvas.width, laneY);
      context.stroke();
    }
  }

  function drawTowers() {
    const towerWidth = 34;
    const towerHeight = 170;

    context.fillStyle = "#4da0ff";
    context.fillRect(58, 165, towerWidth, towerHeight);

    context.fillStyle = "#ff6b6b";
    context.fillRect(canvas.width - 92, 165, towerWidth, towerHeight);
  }

  function drawUnits() {
    for (const unit of state.units) {
      const profile = charById.get(unit.characterId);
      if (!profile) {
        continue;
      }
      context.beginPath();
      context.fillStyle = profile.color;
      context.arc(unit.x, unit.y, unitRadius, 0, Math.PI * 2);
      context.fill();

      const hpRatio = Math.max(0, unit.hp) / profile.hp;
      context.fillStyle = "#101522";
      context.fillRect(unit.x - 16, unit.y - 24, 32, 4);
      context.fillStyle = "#6bff9a";
      context.fillRect(unit.x - 16, unit.y - 24, 32 * hpRatio, 4);
    }
  }

  function drawOverlay() {
    if (!state.ended) {
      return;
    }

    context.fillStyle = "rgba(6,9,18,0.65)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.font = "700 36px Inter, sans-serif";
    context.textAlign = "center";
    context.fillText(state.winner === "player" ? "VICTORY" : "DEFEAT", canvas.width / 2, 215);
    context.font = "500 20px Inter, sans-serif";
    context.fillText("Press Start Level for another run", canvas.width / 2, 255);
  }

  function draw() {
    context.fillStyle = "#141935";
    context.fillRect(0, 0, canvas.width, canvas.height);

    drawLanes();
    drawTowers();
    drawUnits();
    drawOverlay();
  }

  function refreshHud() {
    const level = getSelectedLevel();
    ui.levelName.textContent = `${level.name} | Coins: ${state.coins}`;
    ui.elixirValue.textContent = state.playerElixir.toFixed(1);
    ui.timeValue.textContent = Math.max(0, Math.ceil(level.duration - state.elapsed));
    ui.playerKingHp.textContent = Math.max(0, Math.ceil(state.playerKingHp));
    ui.enemyKingHp.textContent = Math.max(0, Math.ceil(state.enemyKingHp));
    ui.selectedLane.textContent = state.selectedLane === null ? "None" : String(state.selectedLane + 1);

    const selectedCard = charById.get(state.selectedCardId);
    ui.selectedCard.textContent = selectedCard ? `${selectedCard.name} (${selectedCard.cost})` : "None";
  }

  function renderCards() {
    ui.cardBar.innerHTML = "";

    for (const card of characters) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "card";
      if (card.id === state.selectedCardId) {
        button.classList.add("selected");
      }
      button.innerHTML = `
        <strong>${card.name}</strong><br />
        <small>Cost ${card.cost} | HP ${card.hp} | DMG ${card.damage}</small>
      `;
      button.addEventListener("click", () => {
        state.selectedCardId = card.id;
        renderCards();
      });

      ui.cardBar.appendChild(button);
    }
  }

  function renderCampaignButtons() {
    ui.campaignButtons.innerHTML = "";

    for (const level of levels) {
      const unlocked = level.id <= state.unlockedLevel;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "level-btn";
      if (!unlocked) {
        button.classList.add("locked");
      }
      if (level.id === state.selectedLevelId) {
        button.classList.add("active");
      }

      button.disabled = !unlocked;
      button.textContent = unlocked ? level.name : `Level ${level.id} (Locked)`;
      button.addEventListener("click", () => {
        state.selectedLevelId = level.id;
        resetRun(true);
        renderCampaignButtons();
      });
      ui.campaignButtons.appendChild(button);
    }
  }

  function resetRun(silent) {
    const level = getSelectedLevel();

    state.running = false;
    state.ended = false;
    state.winner = null;
    state.elapsed = 0;
    state.playerElixir = 5;
    state.enemyElixir = 5;
    state.enemySpawnTimer = 0;
    state.playerKingHp = level.playerKingHp;
    state.enemyKingHp = level.enemyKingHp;
    state.units = [];

    if (!silent) {
      ui.statusText.textContent = "Run reset. Press Start Level.";
    }
  }

  function startRun() {
    resetRun(true);
    state.running = true;
    ui.statusText.textContent = "Battle started.";
  }

  function bindEvents() {
    document.querySelectorAll(".lane-btn").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedLane = Number(button.dataset.lane);
        placePlayerUnit();
      });
    });

    ui.startBtn.addEventListener("click", startRun);
    ui.resetBtn.addEventListener("click", () => resetRun(false));

    document.addEventListener("keydown", (event) => {
      if (event.key === "1") {
        state.selectedLane = 0;
        placePlayerUnit();
      }
      if (event.key === "2") {
        state.selectedLane = 1;
        placePlayerUnit();
      }
      if (event.key === "3") {
        state.selectedLane = 2;
        placePlayerUnit();
      }
      if (event.key.toLowerCase() === "s") {
        startRun();
      }
    });
  }

  loadProgress();
  resetRun(true);
  renderCards();
  renderCampaignButtons();
  bindEvents();

  requestAnimationFrame((now) => {
    state.lastFrameAt = now;
    requestAnimationFrame(tick);
  });
})();
