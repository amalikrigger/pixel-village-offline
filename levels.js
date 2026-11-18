// Offline campaign level scaffold.
// You can tune enemy pressure and rewards here.
window.GAME_LEVELS = [
  {
    id: 1,
    name: "Level 1 - Warmup",
    duration: 95,
    enemyKingHp: 2400,
    playerKingHp: 2600,
    enemyElixirPerSecond: 0.85,
    spawnIntervalMs: 1700,
    rewardCoins: 100,
    enemyRoster: ["knight", "archer"]
  },
  {
    id: 2,
    name: "Level 2 - Pressure",
    duration: 110,
    enemyKingHp: 2800,
    playerKingHp: 2600,
    enemyElixirPerSecond: 1.0,
    spawnIntervalMs: 1450,
    rewardCoins: 140,
    enemyRoster: ["knight", "archer", "lancer"]
  },
  {
    id: 3,
    name: "Level 3 - Boss Push",
    duration: 125,
    enemyKingHp: 3300,
    playerKingHp: 2600,
    enemyElixirPerSecond: 1.18,
    spawnIntervalMs: 1200,
    rewardCoins: 220,
    enemyRoster: ["knight", "archer", "lancer", "brute"]
  }
];
