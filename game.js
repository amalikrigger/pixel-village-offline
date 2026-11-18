/* ==========================================================================
 * Pixel Village — core architecture (Phaser 3)
 * --------------------------------------------------------------------------
 *  1. CONFIG ......... tunable constants
 *  2. TOOLS .......... data-driven building / tool definitions
 *  3. ART ............ 8-bit sprites as Arne16 palette strings (no asset files)
 *  4. GameState ...... pure simulation & economy (no rendering, no DOM)
 *  5. UIController ... DOM HUD + toolbar (writes to the DOM only on change)
 *  6. VillageScene ... Phaser rendering, camera, input, grid placement
 *  7. Boot
 *
 * Layers talk through a single event bus so the simulation can later be
 * saved/loaded, unit-tested, or moved to a worker without touching rendering.
 * ======================================================================== */
'use strict';

/* ==========================================================================
 * 1. CONFIG
 * ======================================================================== */
const CONFIG = Object.freeze({
  ART_SCALE: 2,            // each art pixel = 2 world pixels
  TILE: 32,                // 16px art * ART_SCALE
  UI_ART_SCALE: 3,         // sidebar / HUD icons are drawn a bit larger
  MAP_W: 80,               // Meadow (starting biome) size in tiles; only the centre is buildable at first
  LEGACY_MAP_SIZE: 64,     // map size of saves made before land expansion existed
  LAND_START: 24,          // starting buildable area (tiles per side, centred)
  LAND_PER_LEVEL: 8,       // tiles per side gained per Land Expansion level

  TICK_LEVELS: [3000, 2500, 2000, 1600, 1250, 1000, 750], // ms per economy tick at each speed level
  TICK_UPGRADE_COSTS: [150, 400, 900, 2000, 4500, 9000],    // coins to reach the next speed level
  MAX_POWER_BONUS: 0.5,    // cap on the town-wide income bonus from power plants
  START_COINS: 1500,
  START_MATERIALS: 60,
  SAVE_KEY: 'pixelVillage.save.v1',
  AUTOSAVE_MS: 15000,      // also saves on every economy tick and when the tab is hidden/closed
  BASE_HAPPINESS: 50,
  UNCONNECTED_FACTOR: 0.5, // output multiplier for buildings not touching a road
  RESIDENTS_PER_SHOP: 6,   // customers one shop needs to run at full income
  HOUSES_PER_SHOP: 4,      // houses one shop can serve (happiness)
  GROWTH_MIN_HAPPINESS: 35,
  REFUND_RATE: 0.75,

  // Defense tower upgrades (inspect a tower to upgrade it)
  TOWER_MAX_LEVEL: 5,
  TOWER_UPGRADE_COST: [1, 2, 4, 8], // x the tower's build cost to reach Lv 2, 3, 4, 5
  TOWER_LEVEL_BONUS: { damage: 0.5, range: 0.5, rate: 0.1 }, // per level: +50% dmg, +0.5 tiles, -10% reload
  OFFLINE_RATE: 0.5,              // share of normal income earned while the game is closed
  OFFLINE_MAX_MS: 2 * 60 * 60 * 1000, // offline earnings cap (2 hours)

  ZOOM_LEVELS: [0.5, 0.75, 1, 1.5, 2, 3], // discrete steps keep pixels crisp
  START_ZOOM_INDEX: 3,
  PAN_SPEED: 700,          // screen px / second for keyboard panning
  CLICK_SLOP: 6,           // px of movement before a click becomes a drag
  WHEEL_COOLDOWN_MS: 90,   // stops trackpads skipping through zoom levels
  FLOAT_POOL_SIZE: 48,

  // Villagers who stroll along the roads (purely cosmetic)
  WALKER_MAX: 40,            // hard cap on walkers on screen/map
  WALKER_BASE: 2,            // walkers that appear as soon as any road exists
  RESIDENTS_PER_WALKER: 3,   // +1 walker for every N residents
  WALKER_SPAWN_MS: 300,      // how often we add/remove one walker to reach the target
  WALKER_SPEED_MIN: 16,      // world px / second
  WALKER_SPEED_MAX: 30,
  WALKER_FRAME_MS: 160,      // walk-cycle frame duration
  WALKER_PAUSE_CHANCE: 0.08, // chance to stop for a chat at each tile

  // Raids: every unlocked biome is attacked now and then. Defend the Town Hall!
  RAID_FIRST_MS: 3 * 60 * 1000,  // grace period before a biome's first raid
  RAID_STAGGER_MS: 60 * 1000,    // extra grace per biome on old saves so raids don't all line up
  RAID_MIN_MS: 4 * 60 * 1000,    // time between raids (random in [min, max])
  RAID_MAX_MS: 6 * 60 * 1000,
  RAID_WARN_MS: 30 * 1000,       // warning before a raid starts
  RAID_SPAWN_MS: 800,            // gap between raiders arriving
  RAID_REWARD: 10000,            // coins for defeating a raid
  RAID_MAX_ENEMIES: 40,          // cap on raiders per raid
  RAID_HP_PER_WAVE: 0.3,         // raider HP grows 30% per raid survived in that biome
  RAID_COUNT_PER_WAVE: 1.5,      // and their numbers grow too
  RAID_EARLY_BONUS: 0.6,         // up to +60% coins for calling a raid in before it was due
  RAID_CALL_LEAD_MS: 5 * 1000,   // short "here they come" delay after you call a raid
  HALL_HP: 100,                  // Town Hall health; repaired after every raid
  HALL_REACH: 1.15,              // tiles from the hall's centre where raiders strike it
});

// Indices into the generated tileset strip (order must match generateTextures)
const TILE_INDEX = Object.freeze({ GRASS: 0, GRASS_ALT: 1, FLOWERS: 2, ROAD: 3 });

const ERR = Object.freeze({
  BOUNDS: 'Out of bounds',
  OCCUPIED: 'Tile is occupied',
  COINS: 'Not enough coins!',
  MATERIALS: 'Not enough wood!',
  MAXED: 'Tick speed is already maxed!',
  UPGRADE_MAXED: 'Already at max level!',
  LOCKED: 'Locked! Unlock it in the Tech Tree.',
  TIER_LOCKED: 'Unlock the previous tier first!',
  TIER_DONE: 'Already unlocked!',
  LAND: 'Not your land yet! Buy Land Expansion in Upgrades.',
  BIOME: "That can't be built in this biome!",
  BIOME_ORDER: 'Unlock the previous biome first!',
  BIOME_DONE: 'Biome already unlocked!',
  BIOME_LOCKED: 'That biome is still locked!',
});

/* ==========================================================================
 * 1b. BIOMES — separate maps, unlocked in order with coins. Each one is
 *     bigger than the last and has its own terrain + structures (see TOOLS).
 *     `ground` = [main, alt, decoration] tile art keys.
 * ======================================================================== */
const BIOMES = Object.freeze([
  { id: 'meadow',  name: 'Meadow',  icon: '\u{1F333}', size: CONFIG.MAP_W, cost: 0,
    ground: ['grass1', 'grass2', 'grass3'],
    desc: 'Rolling green fields where every village begins.' },
  { id: 'desert',  name: 'Desert',  icon: '\u{1F3DC}\uFE0F', size: 96, cost: 10000,
    ground: ['desert0', 'desert1', 'desert2'],
    desc: 'Hot sand and ancient wonders: adobe huts, bazaars and pyramids.' },
  { id: 'tundra',  name: 'Tundra',  icon: '\u2744\uFE0F', size: 112, cost: 50000,
    ground: ['tundra0', 'tundra1', 'tundra2'],
    desc: 'Frozen plains: igloos, ice fisheries and a glittering ice castle.' },
  { id: 'jungle',  name: 'Jungle',  icon: '\u{1F334}', size: 128, cost: 250000,
    ground: ['jungle0', 'jungle1', 'jungle2'],
    desc: 'Dense rainforest: treehouses, bamboo groves and a lost temple.' },
  { id: 'volcano', name: 'Volcano', icon: '\u{1F30B}', size: 144, cost: 1250000,
    ground: ['volcano0', 'volcano1', 'volcano2'],
    desc: "Molten riches: lava forges, crystal mines and a dragon's lair." },
].map((b) => Object.freeze(b)));

const BIOME_BY_ID = Object.freeze(Object.fromEntries(BIOMES.map((b) => [b.id, b])));

/* ==========================================================================
 * 1c. RAIDERS — each biome is attacked by its own kind of enemy.
 *     speed in tiles/second, dmg = Town Hall damage when one gets through
 *     (HALL_HP 100: 2-3 raiders reaching the hall destroys it).
 * ======================================================================== */
const ENEMIES = Object.freeze({
  meadow:  { name: 'Goblin',     plural: 'Goblins',        hp: 30,   speed: 1.1, dmg: 34, count: 3 },
  desert:  { name: 'Scorpion',   plural: 'Sand Scorpions', hp: 120,  speed: 1.3, dmg: 34, count: 4 },
  tundra:  { name: 'Yeti',       plural: 'Yetis',          hp: 400,  speed: 0.8, dmg: 50, count: 4 },
  jungle:  { name: 'Raptor',     plural: 'Raptors',        hp: 700,  speed: 1.8, dmg: 34, count: 6 },
  volcano: { name: 'Fire Golem', plural: 'Fire Golems',    hp: 2500, speed: 0.7, dmg: 50, count: 5 },
});

/* ==========================================================================
 * 1d. MUTATIONS — every raid you survive, the enemy adapts. Wave 0 is the
 *     plain raider; each later wave picks the next mutation in this list and
 *     the list repeats at a higher rank (Elite -> Ancient -> Nightmare).
 *     Multipliers stack on top of the usual per-wave HP/count growth.
 *     tint recolours the sprite so you can see what's coming.
 * ======================================================================== */
const mutation = (o) => Object.freeze({
  name: '', desc: '', hp: 1, speed: 1, dmg: 1, count: 1, scale: 1,
  tint: 0,          // sprite tint (0 = none)
  resist: 1,        // multiplier on damage taken from towers
  regen: 0,         // share of max HP healed per second
  slowProof: false, // ignores Frost/slow effects
  split: 0,         // how many weaker copies appear when one dies
  ...o,
});

const RAID_MUTATIONS = Object.freeze([
  mutation({ id: 'swift',   name: 'Swift',     tint: 0x8ff7a7, speed: 1.5, hp: 0.8, scale: 0.9,
    desc: '50% faster, but thinner skinned' }),
  mutation({ id: 'armored', name: 'Armored',   tint: 0xa6b7c9, resist: 0.55, speed: 0.85, hp: 1.1,
    desc: 'takes 45% less tower damage' }),
  mutation({ id: 'horde',   name: 'Swarming',  tint: 0xf7b26b, count: 1.9, hp: 0.55, scale: 0.8,
    desc: 'nearly twice as many, half as tough' }),
  mutation({ id: 'brutal',  name: 'Brutal',    tint: 0xbe2633, dmg: 1.7, hp: 1.3, count: 0.8, scale: 1.1,
    desc: 'hits the Town Hall far harder' }),
  mutation({ id: 'ember',   name: 'Hotblooded', tint: 0xff8a3c, slowProof: true, speed: 1.2,
    desc: 'cannot be slowed by Frost towers' }),
  mutation({ id: 'regen',   name: 'Regrowing', tint: 0x5fd68a, regen: 0.06, hp: 1.15,
    desc: 'heals 6% of its health every second' }),
  mutation({ id: 'splitter', name: 'Splitting', tint: 0xd58ef7, hp: 0.9, split: 2, count: 0.8,
    desc: 'breaks into two smaller raiders when killed' }),
  mutation({ id: 'titan',   name: 'Titan',     tint: 0x8a6b3f, hp: 2.4, speed: 0.7, dmg: 1.4, count: 0.5, scale: 1.4,
    desc: 'huge, slow and very hard to drop' }),
]);

const BASE_MUTATION = mutation({ id: 'base', name: '', desc: 'the ordinary raiders of this biome' });
const RAID_RANKS = Object.freeze(['', 'Elite ', 'Ancient ', 'Nightmare ']);

/** The raider a biome fields on a given wave: stats, looks and special tricks. */
function raiderFor(biome, wave) {
  const base = ENEMIES[biome];
  const w = Math.max(0, Math.floor(wave || 0));
  const m = w === 0 ? BASE_MUTATION : RAID_MUTATIONS[(w - 1) % RAID_MUTATIONS.length];
  const cycle = w === 0 ? 0 : Math.floor((w - 1) / RAID_MUTATIONS.length);
  const rank = RAID_RANKS[Math.min(cycle, RAID_RANKS.length - 1)];
  const prefix = `${rank}${m.name ? `${m.name} ` : ''}`;
  const growth = 1 + w * CONFIG.RAID_HP_PER_WAVE;
  return {
    biome,
    wave: w,
    mutation: m.id,
    trait: m.name,
    desc: m.desc,
    name: `${prefix}${base.name}`,
    plural: `${prefix}${base.plural}`,
    hp: Math.max(1, Math.round(base.hp * growth * m.hp)),
    speed: base.speed * m.speed,
    dmg: Math.max(1, Math.round(base.dmg * m.dmg)),
    count: clamp(Math.round((base.count + w * CONFIG.RAID_COUNT_PER_WAVE) * m.count), 1, CONFIG.RAID_MAX_ENEMIES),
    tint: m.tint,
    scale: m.scale,
    resist: m.resist,
    regen: m.regen,
    slowProof: m.slowProof,
    split: m.split,
  };
}

/* ==========================================================================
 * 2. TOOLS — add a new building by adding an entry here + its ART.
 * ======================================================================== */
const TOOL_DEFAULTS = {
  w: 1, h: 1,
  cost: { coins: 0, materials: 0 },
  income: 0, residents: 0, happiness: 0, materialsPerTick: 0,
  incomePerSec: 0,         // flat coins per real second (unaffected by multipliers)
  customers: 0,            // residents a commercial building needs for full income
  power: 0,                // town-wide income bonus (0.1 = +10%)
  uiScale: CONFIG.UI_ART_SCALE,
  paint: true, isRoad: false, // paint: hold & drag to place/remove repeatedly
  biome: 'meadow',         // biome it can be built in (null = every biome)
  tower: null,             // defense: { range (tiles), damage, rate (ms), slow?, slowMs?, splash?, color }
  hall: false,             // the Town Hall (one per biome, can't be removed)
};

/** Shorthand for a biome's defense tower (always unlocked once you're in that biome). */
const towerTool = (biome, id, name, cost, tower, desc) => ({
  id, biome, kind: 'build', name, art: id, texture: id, uiScale: 2, cost, tower: Object.freeze(tower), desc,
});

/** A tower's combat stats at a given level (Lv 1 = its base definition). */
function towerStatsAt(base, level) {
  const n = level - 1;
  const b = CONFIG.TOWER_LEVEL_BONUS;
  return Object.freeze({
    ...base,
    damage: Math.round(base.damage * (1 + b.damage * n)),
    range: base.range + b.range * n,
    rate: Math.round(base.rate * (1 - b.rate * n)),
  });
}

/** Shorthand for biome-specific buildings (art + texture share the id). */
const biomeTool = (biome, id, name, props) => ({ id, biome, kind: 'build', name, art: id, texture: id, ...props });

const TOOLS = [
  { id: 'pan',      kind: 'pan',      name: 'Inspect',  art: 'pan', biome: null,
    desc: 'Drag to pan. Click a building to inspect it, or a defense tower to upgrade it.' },
  { id: 'road',     kind: 'build',    name: 'Road',     art: 'road', texture: 'tile_road', biome: null,
    cost: { coins: 1, materials: 0 }, paint: true, isRoad: true,
    desc: 'Click & drag to paint. Buildings touching a road work at 100%.' },
  { id: 'house',    kind: 'build',    name: 'House',    art: 'house', texture: 'house',
    cost: { coins: 100, materials: 5 }, residents: 4, income: 5,
    desc: 'Home for 4 villagers. Pays a little rent.' },
  { id: 'shop',     kind: 'build',    name: 'Shop',     art: 'shop', texture: 'shop',
    cost: { coins: 200, materials: 10 }, income: 18, customers: CONFIG.RESIDENTS_PER_SHOP,
    desc: 'Solid earner. Needs customers for full sales.' },
  { id: 'park',     kind: 'build',    name: 'Park',     art: 'park', texture: 'park',
    cost: { coins: 60, materials: 0 }, income: 2, happiness: 6, paint: true,
    desc: 'Happy villagers boost ALL income. Small donations.' },
  { id: 'mill',     kind: 'build',    name: 'Lumber Mill', art: 'mill', texture: 'mill',
    cost: { coins: 150, materials: 0 }, income: 6, materialsPerTick: 10, happiness: -3,
    desc: 'Produces wood and sells a little. A bit noisy.' },
  { id: 'power',    kind: 'build',    name: 'Power Plant', art: 'power', texture: 'power',
    cost: { coins: 400, materials: 25 }, income: 12, power: 0.1, happiness: -6,
    desc: `Each plant boosts ALL income by 10% (max +${CONFIG.MAX_POWER_BONUS * 100}%). Smoky.` },
  { id: 'bar',      kind: 'build',    name: 'Bar',      art: 'bar', texture: 'bar',
    cost: { coins: 250, materials: 20 }, income: 10, happiness: 2, customers: 4,
    desc: 'Villagers unwind here. Needs customers.' },
  { id: 'amusement', kind: 'build',   name: 'Fun Park', art: 'amusement', texture: 'amusement',
    w: 2, h: 2, uiScale: 2,
    cost: { coins: 1500, materials: 80 }, income: 40, happiness: 10, customers: 12,
    desc: 'Huge 2x2 amusement park. Big money, big smiles. Needs lots of customers.' },
  { id: 'bulldoze', kind: 'bulldoze', name: 'Bulldoze', art: 'bulldoze', paint: true, biome: null,
    desc: `Remove a structure. Refunds ${CONFIG.REFUND_RATE * 100}% of its coins.` },

  // ---- Tech-tree-gated structures (see TIERS below) ----
  { id: 'farm',      kind: 'build', name: 'Farm',       art: 'farm', texture: 'farm',
    cost: { coins: 100, materials: 0 }, income: 4, materialsPerTick: 8,
    desc: 'Cheap wood, early game. Grows crops on the outskirts.' },
  { id: 'school',    kind: 'build', name: 'School',     art: 'school', texture: 'school',
    cost: { coins: 220, materials: 10 }, happiness: 8,
    desc: 'Educates villagers. Pure happiness, no upkeep needed.' },
  { id: 'market',    kind: 'build', name: 'Market',     art: 'market', texture: 'market',
    cost: { coins: 350, materials: 20 }, income: 28, customers: 10,
    desc: 'Bigger than a shop. Needs a lot of customers, pays out big.' },
  { id: 'factory',   kind: 'build', name: 'Factory',    art: 'factory', texture: 'factory',
    cost: { coins: 500, materials: 10 }, income: 10, materialsPerTick: 14, happiness: -8,
    desc: 'Mass-produces wood fast. Extremely noisy.' },
  { id: 'clinic',    kind: 'build', name: 'Clinic',     art: 'clinic', texture: 'clinic',
    cost: { coins: 450, materials: 15 }, income: 4, happiness: 12,
    desc: 'Keeps villagers healthy. Strong happiness boost.' },
  { id: 'apartment', kind: 'build', name: 'Apartment',  art: 'apartment', texture: 'apartment',
    cost: { coins: 600, materials: 30 }, residents: 8, income: 10,
    desc: 'Vertical living for 8 villagers in a single tile.' },
  { id: 'bank',      kind: 'build', name: 'Bank',       art: 'bank', texture: 'bank',
    cost: { coins: 1200, materials: 20 }, income: 60,
    desc: 'Prestige building. Huge flat income, no customers needed.' },
  { id: 'stadium',   kind: 'build', name: 'Stadium',    art: 'stadium', texture: 'stadium',
    w: 2, h: 2, uiScale: 2,
    cost: { coins: 1200, materials: 120 }, incomePerSec: 1000, happiness: 20,
    desc: 'Enormous 2x2 stadium. Earns a flat 1,000 coins every second.' },
  towerTool('meadow', 'archer', 'Archer Tower', { coins: 150, materials: 5 },
    { range: 4.5, damage: 10, rate: 700, color: 0xf7e26b },
    'Shoots arrows at raiding goblins. Build them around your Town Hall.'),

  // ---- Desert ----
  biomeTool('desert', 'adobe', 'Adobe Hut', {
    cost: { coins: 400, materials: 10 }, residents: 6, income: 8,
    desc: 'Cool clay home for 6 desert dwellers.' }),
  biomeTool('desert', 'cactusfarm', 'Cactus Farm', {
    cost: { coins: 350, materials: 0 }, income: 5, materialsPerTick: 15,
    desc: 'Harvests tough cactus fibre for building.' }),
  biomeTool('desert', 'bazaar', 'Bazaar', {
    cost: { coins: 900, materials: 20 }, income: 60, customers: 10,
    desc: 'Bustling desert market. Needs customers.' }),
  biomeTool('desert', 'oasis', 'Oasis', {
    cost: { coins: 500, materials: 0 }, income: 5, happiness: 10,
    desc: 'Shady palms and cool water. Very relaxing.' }),
  biomeTool('desert', 'pyramid', 'Pyramid', {
    w: 2, h: 2, uiScale: 2,
    cost: { coins: 6000, materials: 150 }, income: 250, happiness: 15, customers: 20,
    desc: 'Ancient 2x2 wonder. Tourists pay big.' }),
  towerTool('desert', 'ballista', 'Ballista', { coins: 800, materials: 20 },
    { range: 5.5, damage: 70, rate: 1200, color: 0xa46422 },
    'Heavy bolts that pierce scorpion shells. Slow but strong.'),

  // ---- Tundra ----
  biomeTool('tundra', 'igloo', 'Igloo', {
    cost: { coins: 1500, materials: 20 }, residents: 10, income: 12,
    desc: 'Snug ice home for 10 villagers.' }),
  biomeTool('tundra', 'fishery', 'Ice Fishery', {
    cost: { coins: 2500, materials: 30 }, income: 90,
    desc: 'Fishing through the ice. Steady income, no customers needed.' }),
  biomeTool('tundra', 'lodge', 'Pine Lodge', {
    cost: { coins: 2000, materials: 0 }, income: 15, materialsPerTick: 30, happiness: -2,
    desc: 'Chops frosty pines into lots of wood.' }),
  biomeTool('tundra', 'hotspring', 'Hot Spring', {
    cost: { coins: 3000, materials: 0 }, income: 10, happiness: 15,
    desc: 'Steaming pools. Villagers love a warm soak.' }),
  biomeTool('tundra', 'icecastle', 'Ice Castle', {
    w: 2, h: 2, uiScale: 2,
    cost: { coins: 25000, materials: 400 }, income: 800, happiness: 20, customers: 30,
    desc: 'Glittering 2x2 palace of ice. Needs a big crowd.' }),
  towerTool('tundra', 'frosttower', 'Frost Tower', { coins: 3000, materials: 40 },
    { range: 5, damage: 60, rate: 600, slow: 0.5, slowMs: 1500, color: 0xb2dcef },
    'Ice shards that damage and SLOW yetis by 50%.'),

  // ---- Jungle ----
  biomeTool('jungle', 'treehouse', 'Treehouse', {
    cost: { coins: 6000, materials: 50 }, residents: 16, income: 25,
    desc: 'Big homes up in the canopy for 16 villagers.' }),
  biomeTool('jungle', 'fruitstand', 'Fruit Market', {
    cost: { coins: 12000, materials: 60 }, income: 400, customers: 16,
    desc: 'Exotic fruit sells fast. Needs customers.' }),
  biomeTool('jungle', 'bamboo', 'Bamboo Grove', {
    cost: { coins: 8000, materials: 0 }, income: 30, materialsPerTick: 60,
    desc: 'Fast-growing bamboo: a huge supply of wood.' }),
  biomeTool('jungle', 'waterfall', 'Waterfall', {
    cost: { coins: 10000, materials: 0 }, income: 40, happiness: 20,
    desc: 'A breathtaking view. Big happiness boost.' }),
  biomeTool('jungle', 'temple', 'Lost Temple', {
    w: 2, h: 2, uiScale: 2,
    cost: { coins: 120000, materials: 1000 }, income: 3000, happiness: 25, customers: 40,
    desc: 'Rediscovered 2x2 ruins. Explorers flock here.' }),
  towerTool('jungle', 'darttower', 'Dart Tower', { coins: 12000, materials: 80 },
    { range: 5, damage: 45, rate: 200, color: 0xa3ce27 },
    'Rapid-fire blowdarts. Fast enough to catch raptors.'),

  // ---- Volcano ----
  biomeTool('volcano', 'obsidian', 'Obsidian Den', {
    cost: { coins: 30000, materials: 150 }, residents: 24, income: 60,
    desc: 'Heat-proof homes for 24 brave villagers.' }),
  biomeTool('volcano', 'forge', 'Lava Forge', {
    cost: { coins: 50000, materials: 0 }, income: 200, materialsPerTick: 150, happiness: -5,
    desc: 'Smelts building materials with lava. Loud and hot.' }),
  biomeTool('volcano', 'geothermal', 'Geothermal Plant', {
    cost: { coins: 80000, materials: 300 }, income: 500, power: 0.15, happiness: -3,
    desc: `Boosts ALL income by 15% (power cap +${CONFIG.MAX_POWER_BONUS * 100}%).` }),
  biomeTool('volcano', 'crystal', 'Crystal Mine', {
    cost: { coins: 90000, materials: 400 }, income: 1200,
    desc: 'Digs up glowing crystals. Huge flat income.' }),
  biomeTool('volcano', 'dragonlair', "Dragon's Lair", {
    w: 2, h: 2, uiScale: 2,
    cost: { coins: 600000, materials: 3000 }, income: 12000, happiness: 30, customers: 60,
    desc: 'A friendly dragon guards a 2x2 hoard. Legendary income.' }),
  towerTool('volcano', 'magmacannon', 'Magma Cannon', { coins: 70000, materials: 300 },
    { range: 6, damage: 600, rate: 1500, splash: 1.5, color: 0xeb8931 },
    'Lobs molten rock that SPLASHES nearby golems.'),
].map((t) => Object.freeze({ ...TOOL_DEFAULTS, ...t }));

/** The Town Hall: placed automatically at the centre of every biome. Not in the toolbar. */
const TOWN_HALL = Object.freeze({
  ...TOOL_DEFAULTS,
  id: 'townhall', kind: 'build', name: 'Town Hall', art: 'townhall', texture: 'townhall',
  biome: null, w: 2, h: 2, uiScale: 2, paint: false, hall: true,
  desc: 'The heart of your village. If raiders destroy it, you lose!',
});

const TOOL_BY_ID = Object.freeze(Object.fromEntries([...TOOLS, TOWN_HALL].map((t) => [t.id, t])));

/** Each biome's defense tower. */
const TOWER_OF_BIOME = Object.freeze(Object.fromEntries(
  BIOMES.map((b) => [b.id, TOOLS.find((t) => t.tower && t.biome === b.id)]),
));

/** Tools shown in each biome: universal tools (biome: null) + that biome's buildings. */
const TOOLS_BY_BIOME = Object.freeze(Object.fromEntries(
  BIOMES.map((b) => [b.id, TOOLS.filter((t) => !t.biome || t.biome === b.id)]),
));

/* ==========================================================================
 * 2b. TECH TREE — sequential tiers gating which structures can be built.
 *     Unlocking a tier is a one-time coin cost; buildings keep their own
 *     per-placement cost on top of that. Tiers must be unlocked in order.
 * ======================================================================== */
const ALWAYS_UNLOCKED = Object.freeze(new Set(['pan', 'road', 'house', 'bulldoze', 'archer']));

const TIERS = Object.freeze([
  { id: 't1', name: 'Foundations', cost: 100,  buildings: ['shop', 'farm'] },
  { id: 't2', name: 'Community',   cost: 300,  buildings: ['park', 'school'] },
  { id: 't3', name: 'Industry',    cost: 700,  buildings: ['mill', 'market'] },
  { id: 't4', name: 'Power Age',   cost: 1400, buildings: ['power', 'factory'] },
  { id: 't5', name: 'Leisure',     cost: 2500, buildings: ['bar', 'clinic'] },
  { id: 't6', name: 'Luxury',      cost: 4500, buildings: ['apartment', 'bank'] },
  { id: 't7', name: 'Wonders',     cost: 8000, buildings: ['amusement', 'stadium'] },
].map((t) => Object.freeze(t)));

const TIER_BY_ID = Object.freeze(Object.fromEntries(TIERS.map((t) => [t.id, t])));

/** tool id -> tier that gates it (undefined for always-unlocked utility tools). */
const TIER_OF_TOOL = Object.freeze(
  Object.fromEntries(TIERS.flatMap((t) => t.buildings.map((id) => [id, t]))),
);

/* ==========================================================================
 * 2c. TOWN UPGRADES — permanent, levelled boosts bought with coins.
 *     `per` is the bonus gained per level; `label` formats the total bonus.
 *     Add a new upgrade here, then apply upgradeBonus(id) in GameState.
 * ======================================================================== */
const UPGRADES = Object.freeze([
  { id: 'towers',   name: 'Defense Towers', icon: '\u{1F3F9}', per: 1, towers: true,
    costs: [400, 1000, 2500, 6000], // one per tower level above 1 (see CONFIG.TOWER_MAX_LEVEL)
    desc: 'Upgrades EVERY defense tower in every biome (Archer, Ballista, Frost, Dart, Magma): more damage, faster shots, longer range.',
    label: (v) => {
      const b = CONFIG.TOWER_LEVEL_BONUS;
      return v
        ? `Tower Lv ${1 + v}: +${Math.round(b.damage * v * 100)}% dmg, -${Math.round(b.rate * v * 100)}% reload, +${b.range * v} range`
        : 'Tower Lv 1: base stats';
    } },
  { id: 'coins',    name: 'Tax Office',   icon: '\u{1F4B0}', per: 0.1,
    costs: [500, 1200, 2800, 6000, 13000],
    desc: 'Boosts ALL coin income.',
    label: (v) => `+${Math.round(v * 100)}% coins` },
  { id: 'commerce', name: 'Advertising',  icon: '\u{1F4E3}', per: 0.15,
    costs: [400, 1000, 2400, 5500],
    desc: 'Shops, markets, bars & other customer-based buildings earn more.',
    label: (v) => `+${Math.round(v * 100)}% shop income` },
  { id: 'wood',     name: 'Sharp Saws',   icon: '\u{1FA93}', per: 0.25,
    costs: [250, 600, 1400, 3200, 7000],
    desc: 'Farms, mills & factories produce more wood.',
    label: (v) => `+${Math.round(v * 100)}% wood` },
  { id: 'housing',  name: 'Bigger Homes', icon: '\u{1F3E0}', per: 1,
    costs: [350, 900, 2200, 5000],
    desc: 'Every house & apartment fits more villagers.',
    label: (v) => `+${v} villagers/home` },
  { id: 'festival', name: 'Festivals',    icon: '\u{1F389}', per: 4,
    costs: [300, 800, 2000, 4500, 9000],
    desc: 'Regular celebrations keep the whole town happier.',
    label: (v) => `+${v} happiness` },
  { id: 'paths',    name: 'Dirt Paths',   icon: '\u{1F6E4}\uFE0F', per: 0.1,
    costs: [200, 500, 1200, 2800, 6000],
    desc: 'Buildings without a road lose less output.',
    label: (v) => `${Math.round((CONFIG.UNCONNECTED_FACTOR + v) * 100)}% off-road output` },
  { id: 'land',     name: 'Land Expansion', icon: '\u{1F5FA}\uFE0F', per: CONFIG.LAND_PER_LEVEL,
    // One level per ring of land until the buildable area fills the whole map.
    costs: [300, 800, 1800, 3500, 6500, 11000, 18000]
      .slice(0, Math.floor((CONFIG.MAP_W - CONFIG.LAND_START) / CONFIG.LAND_PER_LEVEL)),
    desc: 'Buy the land around your Meadow village for a bigger grid. (Other biomes come fully owned.)',
    label: (v) => `${CONFIG.LAND_START + v}x${CONFIG.LAND_START + v} land` },
].map((u) => Object.freeze(u)));

const UPGRADE_BY_ID = Object.freeze(Object.fromEntries(UPGRADES.map((u) => [u.id, u])));

/** tower tool id -> town upgrade that levels every tower at once (all towers -> 'towers'). */
const TOWER_UPGRADE_OF = Object.freeze(Object.fromEntries(
  TOOLS.filter((t) => t.tower).map((t) => [t.id, 'towers']),
));

/** Hotkeys 1-9 then 0 for the 10th tool; tools beyond that have no hotkey. */
const toolKey = (i) => (i < 9 ? String(i + 1) : i === 9 ? '0' : '');

/** 32x32 ferris wheel for the 2x2 amusement park, drawn procedurally. */
function makeFerrisWheelArt() {
  const W = 32, H = 32, cx = 16, cy = 12, r = 10;
  const g = Array.from({ length: H }, () => new Array(W).fill('.'));
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = c; };
  const line = (x0, y0, x1, y1, c) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c);
    }
  };

  // A-frame legs
  line(cx - 1, cy, cx - 8, 29, '5'); line(cx, cy, cx - 7, 29, '5');
  line(cx, cy, cx + 7, 29, '5');     line(cx + 1, cy, cx + 8, 29, '5');
  // Spokes
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    line(cx, cy, Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), '1');
  }
  // Rim
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) if (Math.abs(Math.hypot(x - cx, y - cy) - r) < 0.7) set(x, y, '3');
  }
  // Hub
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) set(cx + dx, cy + dy, '0');
  set(cx, cy, '8');
  // Gondolas hanging under each spoke
  const colors = ['8', 'E', '4', 'B', '7', 'D', '2', 'F'];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const gx = Math.round(cx + Math.cos(a) * r);
    const gy = Math.round(cy + Math.sin(a) * r);
    for (let dx = -1; dx <= 1; dx++) {
      set(gx + dx, gy + 1, colors[k]);
      set(gx + dx, gy + 2, colors[k]);
      set(gx + dx, gy + 3, '0');
    }
  }
  // Flag
  set(cx, 0, '0'); set(cx, 1, '0'); set(cx + 1, 0, '3'); set(cx + 2, 0, '3'); set(cx + 1, 1, '3');
  // Platform
  for (let x = 4; x < 28; x++) { set(x, 29, '0'); set(x, 30, '1'); set(x, 31, '0'); }

  return g.map((row) => row.join(''));
}

/** 32x32 oval stadium for the 2x2 stadium tool, drawn procedurally. */
function makeStadiumArt() {
  const W = 32, H = 32, cx = 16, cy = 18, rx = 14, ry = 9;
  const g = Array.from({ length: H }, () => new Array(W).fill('.'));
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = c; };
  const d2 = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = d2(x, y);
      if (d <= 1) g[y][x] = d > 0.55 ? '1' : d > 0.4 ? 'B' : 'A'; // bleachers / track / field
      else if (d <= 1.06) g[y][x] = '0'; // outline
    }
  }
  // Floodlights
  [[2, 5], [29, 5], [2, 11], [29, 11]].forEach(([x, y]) => { set(x, y, '0'); set(x, y + 1, '1'); set(x, y + 2, '8'); });
  // Scoreboard
  for (let x = 11; x <= 20; x++) { set(x, 2, '0'); set(x, 3, '2'); }
  for (let x = 12; x <= 19; x++) set(x, 2, 'D');
  return g.map((row) => row.join(''));
}

/** Returns a copy of a base art with characters swapped per `map` (same dimensions). */
function recolorArt(rows, map) {
  return rows.map((row) => row.split('').map((ch) => map[ch] ?? ch).join(''));
}

/** Returns a copy of a base art with a few pixels overwritten: pokes = [[x, y, char], ...]. */
function decorateArt(rows, pokes) {
  const grid = rows.map((row) => row.split(''));
  for (const [x, y, ch] of pokes) {
    if (grid[y] && x >= 0 && x < grid[y].length) grid[y][x] = ch;
  }
  return grid.map((row) => row.join(''));
}

/* ==========================================================================
 * 3. ART — Arne16 palette used by Phaser's textures.generate():
 *   0 black  1 grey   2 white  3 red    4 pink   5 d.brown 6 brown  7 orange
 *   8 yellow 9 d.teal A green  B lime   C ink    D blue    E sky    F ice
 *   . transparent
 * ======================================================================== */
const ART = {
  grass1: [
    'AAAAAAAAAAAAAAAA', 'AAAAAAAAABAAAAAA', 'AAABAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAABAAA', 'AAAAAABAAAAAAAAA', 'AAAAAAAAAAAAAAAA', 'ABAAAAAAAAAAAAAA',
    'AAAAAAAAAABAAAAA', 'AAAAAAAAAAAAAAAA', 'AAAAABAAAAAAAAAA', 'AAAAAAAAAAAAAABA',
    'AAAAAAAAAAAAAAAA', 'AAABAAAAAAABAAAA', 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAA',
  ],
  grass2: [
    'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAA', 'AAAAABAAAAAAAAAA', 'AAAAAAAAAAAAA9AA',
    'AAAAAAAAAAAAAAAA', 'AA9AAAAAAAAAAAAA', 'AAAAAAAAABAAAAAA', 'AAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAA', 'AAAABAAAAAAAABAA', 'AAAAAAAAAAAAAAAA', 'AAAAAAAA9AAAAAAA',
    'AAAAAAAAAAAAAAAA', 'ABAAAAAAAAAAAAAA', 'AAAAAAAAAAAABAAA', 'AAAAAAAAAAAAAAAA',
  ],
  grass3: [
    'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAA', 'AAA8AAAAAAAAAAAA', 'AA878AAAAAAA2AAA',
    'AAA8AAAAAAA242AA', 'AAABAAAAAAAA2AAA', 'AAAAAAAAAAAABAAA', 'AAAAAAAAAAAAAAAA',
    'AAAAAAA4AAAAAAAA', 'AAAAAA434AAAAAAA', 'AAAAAAA4AAAAAAAA', 'AAAAAAABAAAAA8AA',
    'AA2AAAAAAAAA878A', 'A282AAAAAAAAA8AA', 'AA2AAAAAAAAAABAA', 'AAAAAAAAAAAAAAAA',
  ],
  road: [
    '6666666666666666', '6656666666667666', '6666666566666666', '6676666666666566',
    '6666666666666666', '6666566667666666', '6666666666666656', '6566666666666666',
    '6666667666656666', '6666666666666666', '6666666656666676', '6676666666666666',
    '6666656666666666', '6666666666766666', '6656666666666656', '6666666666666666',
  ],
  house: [
    '......0000......',
    '.....033330.....',
    '....03333330....',
    '...0333333330...',
    '..033333333330..',
    '.03333333333330.',
    '0333333333333330',
    '0555555555555550',
    '.08888888888880.',
    '.08DD888888DD80.',
    '.08DD888888DD80.',
    '.08888888888880.',
    '.08888855888880.',
    '.08888855888880.',
    '.08888857888880.',
    '.00000000000000.',
  ],
  shop: [
    '0000000000000000',
    '0666666666666660',
    '0688888888888860',
    '0666666666666660',
    '0323232323232320',
    '0323232323232320',
    '0000000000000000',
    '0111111111111110',
    '01EEEEE115555110',
    '01EFFFE115555110',
    '01EFFFE115555110',
    '01EEEEE115575110',
    '0111111115555110',
    '0000000000000000',
  ],
  park: [
    '......0000......',
    '....00AAAA00....',
    '...0AABBAAAA0...',
    '..0AABBAAAAAA0..',
    '..0ABAAAAAA9A0..',
    '..0AAAAAAA9AA0..',
    '..0AAAAA9AAA90..',
    '...0AA9AAA990...',
    '....00999900....',
    '......0560......',
    '......0560......',
    '..4...0560...8..',
    '.424.005600.878.',
    '..4..........8..',
  ],
  mill: [
    '....00000000....',
    '...0555555550...',
    '..055555555550..',
    '.05555555555550.',
    '0000000000000000',
    '.06666666666660.',
    '.06565656565650.',
    '.06666600666660.',
    '.06565055065650.',
    '.06666055066660.',
    '.00000000000000.',
    '0767076707670...',
    '0666066606660...',
  ],
  power: [
    '.22.......22....',
    '2112.....2112...',
    '.22.......22....',
    '.00.......00....',
    '.31.......31....',
    '.11.......11....',
    '.31.......31....',
    '.11.......11....',
    '0000000000000000',
    '0111111111111110',
    '0111111881111110',
    '0111118811111110',
    '0111188888111110',
    '0111111881111110',
    '0111118811111110',
    '0000000000000000',
  ],
  bar: [
    '..000000000000..',
    '.05555555555550.',
    '0555555555555550',
    '0000000000000000',
    '0666666666666660',
    '0600000000000060',
    '0608088088080060',
    '0600000000000060',
    '0666666666666660',
    '0677666556667760',
    '0687666556667860',
    '0666666556666660',
    '0000000000000000',
  ],
  amusement: makeFerrisWheelArt(),
  pan: [
    '0', '00', '020', '0220', '02220', '022220', '0222220', '02222220',
    '022222220', '0222222220', '02222200000', '0220220', '020.0220',
    '00..0220', '0....0220', '.....000',
  ],
  bulldoze: [
    '................', '.00..........00.', '.030........030.', '..030......030..',
    '...030....030...', '....030..030....', '.....030030.....', '......0330......',
    '......0330......', '.....030030.....', '....030..030....', '...030....030...',
    '..030......030..', '.030........030.', '.00..........00.', '................',
  ],
  icon_coin:  ['..0000..', '.078870.', '07800870', '07807870', '07807870', '07800870', '.077770.', '..0000..'],
  icon_pop:   ['...00...', '..0770..', '..0770..', '...00...', '.0DDDD0.', '0DDDDDD0', '0DDDDDD0', '.000000.'],
  icon_happy: ['.00..00.', '04300330', '04333330', '03333330', '.033330.', '..0330..', '...00...', '........'],
  icon_mat:   ['........', '00000000', '07666660', '06666660', '00000000', '07666660', '06666660', '00000000'],
};

// ---- Tech-tree building art: recolors/decorations of the base sprites above ----
ART.farm = recolorArt(ART.house, { 3: '6', 8: '3', D: '2' }); // brown roof, red barn wall, white loft window
ART.school = decorateArt(
  recolorArt(ART.house, { 3: 'D', 5: '9', 8: '2', D: '3' }), // blue roof, white walls, red-trim windows
  [[7, 1, '8'], [8, 1, '8']], // little gold cupola bell on the roof peak
);
ART.clinic = decorateArt(
  recolorArt(ART.house, { 3: '2', 5: '1', 8: '2', D: 'F' }), // white building, ice-blue windows
  [[7, 9, '3'], [7, 10, '3'], [6, 10, '3'], [8, 10, '3'], [7, 11, '3']], // red cross
);
ART.apartment = decorateArt(
  recolorArt(ART.house, { 3: '9', 8: '1', D: 'E' }), // dark-teal roof, concrete-grey walls, sky windows
  [[6, 12, 'E'], [7, 12, 'E'], [8, 12, 'E'], [9, 12, 'E']], // extra ground-floor window row
);
ART.market = recolorArt(ART.shop, { 3: 'A', 6: '7' }); // green awning, orange stall walls
ART.bank = recolorArt(ART.shop, { 6: '2', 3: 'D' }); // white walls, blue trim, gold sign stays
ART.factory = recolorArt(ART.mill, { 5: '1', 6: '9', 7: '3' }); // grey roof, dark-teal walls, red pipes
ART.stadium = makeStadiumArt();

/** Tiny canvas for procedural pixel art. Returns rows of palette chars like the ART entries. */
function drawArt(w, h, paint) {
  const g = Array.from({ length: h }, () => new Array(w).fill('.'));
  const set = (x, y, c) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px >= 0 && py >= 0 && px < w && py < h) g[py][px] = c;
  };
  const rect = (x, y, rw, rh, c) => {
    for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) set(i, j, c);
  };
  /** Filled rectangle with a 1px outline. */
  const box = (x, y, rw, rh, fill, edge = '0') => {
    rect(x, y, rw, rh, edge);
    rect(x + 1, y + 1, rw - 2, rh - 2, fill);
  };
  const line = (x0, y0, x1, y1, c) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
    for (let i = 0; i <= n; i++) set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
  };
  /** Filled ellipse with optional outline; rows below maxY are cut off (domes, mounds). */
  const ellipse = (cx, cy, rx, ry, fill, edge = null, maxY = h) => {
    const inside = (x, y) => y <= maxY && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inside(x, y)) continue;
        const rim = edge && (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1));
        set(x, y, rim ? edge : fill);
      }
    }
  };
  /** Triangle (roofs, pines) centred on cx, widening by `slope` px per row. */
  const tri = (cx, top, bottom, fill, edge = '0', slope = 1) => {
    for (let y = top; y <= bottom; y++) {
      const half = Math.floor((y - top) * slope);
      rect(cx - half, y, half * 2 + 1, 1, fill);
      if (edge) { set(cx - half, y, edge); set(cx + half, y, edge); }
    }
  };
  paint({ set, rect, box, line, ellipse, tri });
  return g.map((row) => row.join(''));
}

/** 16x16 ground tile: a base colour with deterministic random specks, plus optional pokes. */
function makeGround(base, specks, seed, pokes = []) {
  let s = seed;
  const rnd = (n) => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return (s >>> 16) % n;
  };
  const g = Array.from({ length: 16 }, () => new Array(16).fill(base));
  for (const [c, n] of specks) for (let i = 0; i < n; i++) g[rnd(16)][rnd(16)] = c;
  for (const [x, y, c] of pokes) g[y][x] = c;
  return g.map((row) => row.join(''));
}

// ---- Biome ground tiles: [main, alt, decoration] per biome (see BIOMES.ground) ----
Object.assign(ART, {
  desert0: makeGround('8', [['7', 10], ['6', 2]], 11),
  desert1: makeGround('8', [['7', 24], ['6', 4]], 23),
  desert2: makeGround('8', [['7', 8]], 37, [ // little cactus + pebbles
    [5, 7, 'A'], [5, 8, 'A'], [5, 9, 'A'], [5, 10, 'A'], [5, 11, 'A'], [3, 7, 'A'], [3, 8, 'A'],
    [4, 9, 'A'], [7, 8, 'A'], [7, 9, 'A'], [6, 10, 'A'], [5, 12, '6'],
    [11, 12, '1'], [12, 12, '1'], [12, 11, '1'], [13, 12, '6'],
  ]),
  tundra0: makeGround('2', [['F', 14], ['1', 1]], 41),
  tundra1: makeGround('2', [['F', 26]], 53),
  tundra2: makeGround('2', [['F', 10]], 67, [ // ice crystal + snowy rock
    [3, 3, 'E'], [3, 4, 'F'], [2, 4, 'F'], [4, 4, 'F'], [3, 5, 'E'],
    [10, 10, '1'], [11, 10, '1'], [12, 10, '2'], [10, 11, '5'], [11, 11, '1'], [12, 11, '1'], [13, 11, '5'],
  ]),
  jungle0: makeGround('A', [['9', 50], ['B', 6]], 71),
  jungle1: makeGround('A', [['9', 85], ['B', 2]], 83),
  jungle2: makeGround('A', [['9', 40]], 97, [ // tropical flowers + fern
    [3, 3, '4'], [2, 4, '4'], [4, 4, '4'], [3, 5, '4'], [3, 4, '8'],
    [11, 10, '3'], [10, 11, '3'], [12, 11, '3'], [11, 12, '3'], [11, 11, '8'],
    [7, 7, 'B'], [6, 8, 'B'], [8, 8, 'B'],
  ]),
  volcano0: makeGround('C', [['0', 14], ['1', 6], ['5', 4]], 101),
  volcano1: makeGround('C', [['0', 24], ['5', 8]], 113),
  volcano2: makeGround('C', [['0', 10]], 127, [ // glowing lava crack
    [2, 4, '3'], [3, 5, '3'], [4, 5, '7'], [5, 6, '3'], [6, 7, '7'], [7, 7, '8'],
    [8, 8, '7'], [9, 9, '3'], [10, 9, '7'], [11, 10, '3'], [12, 11, '3'],
  ]),
});

// ---- Desert buildings ----
ART.adobe = drawArt(16, 16, ({ box, set }) => {
  box(2, 0, 7, 5, '7');                         // upper storey
  box(1, 4, 14, 12, '7');                       // main walls
  for (const [x, y] of [[1, 1], [9, 1], [0, 6], [4, 5], [8, 5], [11, 5], [15, 6]]) set(x, y, '5'); // wooden vigas
  box(3, 7, 4, 4, 'C');                         // window
  box(9, 9, 4, 7, '5');                         // door
});
ART.cactusfarm = drawArt(16, 16, ({ box, rect, set }) => {
  rect(0, 13, 16, 3, '6');
  for (let x = 0; x < 16; x += 3) set(x, 14, '5'); // furrows
  const cactus = (x, top) => {
    box(x - 3, top + 3, 3, 4, 'A');             // left arm
    box(x + 2, top + 2, 3, 4, 'A');             // right arm
    box(x - 1, top, 4, 14 - top, 'A');          // trunk
    set(x, top + 1, 'B'); set(x, top + 4, 'B');
    set(x, top - 1, '4');                       // flower
  };
  cactus(3, 3);
  cactus(11, 5);
});
ART.bazaar = drawArt(16, 16, ({ box, rect, set }) => {
  box(1, 7, 14, 9, '6');                        // stall
  rect(2, 8, 12, 1, 'C');                       // shade under the canopy
  rect(2, 10, 12, 1, '5');                      // counter
  ['3', '8', 'A', '7', '4', '3'].forEach((c, i) => set(3 + i * 2, 9, c)); // goods
  rect(0, 3, 16, 4, '0');                       // canopy
  for (let x = 1; x < 15; x++) rect(x, 4, 1, 2, (x >> 1) % 2 ? '8' : 'D');
  for (let x = 0; x < 16; x += 2) set(x, 6, '.'); // scalloped edge
  rect(7, 0, 1, 3, '5'); set(8, 0, '3'); set(9, 0, '3'); set(8, 1, '3'); // flag
});
ART.oasis = drawArt(16, 16, ({ ellipse, line, set }) => {
  ellipse(9, 12.5, 6.5, 2.8, 'E', 'D');         // pond
  set(8, 12, 'F'); set(9, 12, 'F'); set(12, 13, 'F');
  line(3, 14, 6, 4, '6'); line(4, 14, 7, 4, '5'); // palm trunk
  const fx = 6;
  const fy = 3;
  line(fx, fy, fx - 5, fy + 3, 'A'); line(fx, fy, fx + 5, fy + 3, 'A');
  line(fx, fy, fx - 4, fy - 2, 'B'); line(fx, fy, fx + 4, fy - 2, 'B');
  line(fx, fy, fx, fy - 3, 'A');
  set(fx, fy + 1, '7'); set(fx + 1, fy + 1, '7'); // coconuts
});
ART.pyramid = drawArt(32, 32, ({ rect, set }) => {
  for (let y = 4; y <= 29; y++) {
    const half = Math.floor((y - 4) * 0.6);
    rect(16 - half, y, half + 1, 1, '8');       // sunny side
    rect(17, y, half, 1, '7');                  // shady side
    if ((y - 4) % 5 === 4) rect(16 - half, y, half * 2 + 1, 1, '6'); // stone courses
    set(15 - half, y, '0'); set(17 + half, y, '0');
  }
  set(16, 3, '0'); set(16, 4, '8');
  rect(0, 30, 32, 1, '0');
  rect(14, 24, 4, 6, 'C'); rect(15, 23, 2, 1, 'C'); // doorway
});

// ---- Tundra buildings ----
ART.igloo = drawArt(16, 16, ({ ellipse, rect, set }) => {
  ellipse(8, 15, 7.5, 11, '2', '1', 15);        // dome
  rect(6, 5, 5, 1, 'F'); rect(4, 8, 9, 1, 'F'); rect(3, 11, 11, 1, 'F'); // ice-brick seams
  for (const [x, y] of [[8, 6], [6, 7], [10, 7], [5, 9], [8, 10], [11, 9], [4, 12], [12, 12]]) set(x, y, 'F');
  ellipse(8, 15, 2.5, 3.5, 'C', '1', 15);       // entrance
});
ART.fishery = drawArt(16, 16, ({ ellipse, box, rect, tri, line, set }) => {
  ellipse(8, 13.5, 7.5, 2.5, 'F', 'E');         // ice patch
  ellipse(12.5, 13.5, 1.6, 1, 'D');             // fishing hole
  box(1, 7, 9, 8, '3');                         // red hut
  tri(5, 2, 6, '2');                            // snowy roof
  rect(4, 11, 3, 3, '5');                       // door
  set(7, 9, 'E'); set(8, 9, 'E');               // window
  line(10, 9, 15, 3, '6');                      // rod
  line(15, 4, 13, 13, '1');                     // line
});
ART.lodge = drawArt(16, 16, ({ box, rect, tri, set }) => {
  tri(13, 1, 11, '9', '0', 0.3);                // pine
  for (const [x, y] of [[13, 2], [12, 5], [14, 7], [11, 9], [15, 10]]) set(x, y, '2');
  rect(13, 12, 1, 3, '5');
  rect(7, 2, 2, 3, '1'); set(8, 0, 'F'); set(7, 1, '1'); // chimney + smoke
  box(0, 8, 11, 8, '6');                        // log cabin
  for (const y of [10, 12, 14]) rect(1, y, 9, 1, '5');
  tri(5, 3, 7, '2');                            // snowy roof
  box(2, 10, 3, 3, '8');                        // lit window
  box(6, 11, 3, 5, '5');                        // door
});
ART.hotspring = drawArt(16, 16, ({ ellipse, set }) => {
  ellipse(8, 12, 7.5, 3.5, '1', '0');           // rocky rim
  ellipse(8, 12, 6, 2.2, 'E', 'F');             // warm water
  set(6, 12, 'F'); set(10, 11, 'F');
  for (const [x, y] of [[3, 9], [12, 9], [8, 8]]) set(x, y, '2'); // snow on rocks
  const steam = [[5, 8], [4, 7], [5, 6], [6, 5], [5, 4], [9, 8], [10, 7], [9, 6], [10, 5], [11, 4], [10, 3], [7, 6], [7, 4], [8, 3]];
  for (const [x, y] of steam) set(x, y, y % 2 ? '2' : 'F');
});
ART.icecastle = drawArt(32, 32, ({ box, rect, tri, set }) => {
  box(3, 14, 26, 18, 'F');                      // curtain wall
  box(0, 9, 9, 23, 'F');                        // left tower
  box(23, 9, 9, 23, 'F');                       // right tower
  box(11, 5, 11, 27, 'F');                      // keep
  tri(4, 2, 8, 'D', '0', 0.7);
  tri(27, 2, 8, 'D', '0', 0.7);
  tri(16, 0, 4, 'D', '0', 1.25);
  rect(2, 10, 1, 20, '2'); rect(13, 6, 1, 24, '2'); rect(25, 10, 1, 20, '2'); // shine
  box(3, 13, 3, 4, 'E'); box(26, 13, 3, 4, 'E'); box(14, 9, 5, 5, 'E');        // windows
  box(13, 23, 7, 9, 'C');                       // gate
  rect(4, 0, 1, 2, '1'); set(5, 0, '3');        // flags
  rect(27, 0, 1, 2, '1'); set(28, 0, '3');
});

// ---- Jungle buildings ----
ART.treehouse = drawArt(16, 16, ({ ellipse, box, rect, tri, set }) => {
  rect(6, 9, 1, 7, '0'); rect(7, 9, 3, 7, '5'); rect(10, 9, 1, 7, '0'); // trunk
  ellipse(8, 4.5, 7.5, 4.5, 'A', '9');          // canopy
  for (const [x, y] of [[4, 2], [5, 3], [10, 2], [11, 4], [7, 1]]) set(x, y, 'B');
  box(3, 6, 11, 5, '6');                        // hut
  tri(8, 2, 5, '3', '0', 1.7);                  // roof
  box(4, 7, 3, 3, '8');                         // window
  box(10, 7, 3, 4, '5');                        // door
  for (let y = 11; y < 16; y++) { set(12, y, '7'); set(14, y, '7'); if (y % 2) set(13, y, '7'); } // ladder
});
ART.fruitstand = drawArt(16, 16, ({ box, rect, set, ellipse }) => {
  box(1, 8, 14, 8, '6');                        // stall
  rect(2, 11, 12, 1, '5');                      // counter
  ['3', '8', '7', 'B', '4', '3'].forEach((c, i) => {
    set(3 + i * 2, 9, c); set(2 + i * 2, 10, c); set(3 + i * 2, 10, c);
  });
  ellipse(8, 5, 8, 3.5, 'A', '9', 7);           // leaf-thatch roof
  for (let x = 1; x < 15; x += 2) set(x, 8, 'A');
  set(5, 3, 'B'); set(10, 4, 'B'); set(8, 2, 'B');
});
ART.bamboo = drawArt(16, 16, ({ rect, set }) => {
  for (const [x, top] of [[1, 3], [4, 1], [7, 4], [10, 0], [13, 2]]) {
    rect(x, top, 2, 16 - top, 'B');
    rect(x + 1, top, 1, 16 - top, 'A');
    for (let y = top + 3; y < 16; y += 4) rect(x, y, 2, 1, '9'); // nodes
    set(x - 1, top + 2, 'A'); set(x - 2, top + 3, 'A'); set(x + 2, top + 5, 'A'); set(x + 3, top + 6, 'A');
  }
  rect(0, 15, 16, 1, '5');
});
ART.waterfall = drawArt(16, 16, ({ box, rect, ellipse, set }) => {
  box(0, 1, 16, 12, '1');                       // cliff
  rect(1, 1, 14, 1, 'A'); rect(1, 2, 5, 1, 'A'); rect(11, 2, 4, 1, 'A'); // moss
  for (const [x, y] of [[2, 3], [2, 4], [13, 3], [13, 4], [13, 5]]) set(x, y, 'A'); // vines
  for (const [x, y] of [[3, 7], [12, 9], [4, 10], [11, 6]]) set(x, y, '9');
  rect(6, 1, 4, 12, 'E'); rect(7, 1, 1, 12, 'F'); // falling water
  set(8, 4, 'F'); set(8, 8, 'F'); set(6, 6, 'F');
  ellipse(8, 13.5, 7.5, 2.5, 'D', '0');         // pool
  rect(5, 12, 6, 1, '2'); set(4, 13, 'F'); set(11, 13, 'F'); // splash
});
ART.temple = drawArt(32, 32, ({ box, rect, set }) => {
  box(1, 24, 30, 8, '1');                       // stepped ziggurat
  box(4, 17, 24, 8, '1');
  box(7, 11, 18, 7, '1');
  box(11, 4, 10, 8, '1');                       // shrine
  box(10, 2, 12, 3, '9');                       // roof slab
  for (let y = 12; y < 32; y++) { rect(14, y, 4, 1, y % 2 ? '6' : '5'); set(13, y, '0'); set(18, y, '0'); } // stairs
  box(14, 6, 4, 6, 'C');                        // shrine door
  set(15, 3, '8'); set(16, 3, '8');             // golden idol
  const moss = [[3, 25], [5, 26], [26, 27], [8, 19], [22, 18], [9, 13], [20, 14], [25, 20], [28, 25], [12, 5], [19, 8]];
  for (const [x, y] of moss) set(x, y, (x + y) % 3 ? 'A' : 'B');
  rect(6, 18, 1, 3, 'A'); rect(25, 18, 1, 4, 'A'); rect(2, 25, 1, 4, 'A'); rect(29, 25, 1, 3, 'A'); // vines
});

// ---- Volcano buildings ----
ART.obsidian = recolorArt(ART.house, { 3: '1', 5: '3', 8: 'C', D: '7' }); // grey roof, ink walls, glowing windows
ART.forge = drawArt(16, 16, ({ box, rect, set }) => {
  box(11, 2, 4, 7, '1');                        // chimney
  set(12, 1, '3'); set(13, 1, '7'); set(12, 0, '8'); set(13, 0, '3'); // flames
  box(0, 7, 16, 9, 'C');                        // forge hall
  box(0, 5, 16, 3, '1');                        // roof
  box(5, 10, 6, 6, '7'); rect(6, 11, 4, 4, '8'); set(7, 12, '2'); set(8, 13, '2'); // furnace mouth
  rect(1, 14, 3, 1, '3'); set(2, 13, '7'); rect(12, 14, 3, 1, '3'); set(13, 13, '7'); // lava troughs
});
ART.geothermal = drawArt(16, 16, ({ box, rect, ellipse, set }) => {
  box(1, 5, 5, 11, '1');                        // cooling tower
  rect(2, 8, 3, 1, '3'); rect(2, 11, 3, 1, '3');
  ellipse(11, 15, 4.5, 5, '9', '0', 15);        // turbine dome
  set(11, 12, '8'); set(10, 13, '2');
  box(5, 11, 4, 3, '1');                        // pipe
  for (const [x, y] of [[3, 4], [2, 3], [3, 2], [4, 1], [3, 0]]) set(x, y, y % 2 ? 'F' : '2'); // steam
  rect(0, 15, 1, 1, '3'); rect(15, 15, 1, 1, '7');
});
ART.crystal = drawArt(16, 16, ({ ellipse, set }) => {
  ellipse(8, 16, 8, 11, '1', '0', 15);          // rock mound
  for (const [x, y] of [[4, 9], [11, 8], [6, 6], [13, 12]]) set(x, y, 'C');
  ellipse(8, 16, 3.5, 4.5, 'C', '0', 15);       // mine mouth
  set(6, 15, '6'); set(10, 15, '6');            // rails
  const gem = (x, y, c, hi) => {
    set(x, y - 3, hi); set(x, y - 2, c); set(x - 1, y - 1, c); set(x, y - 1, hi); set(x + 1, y - 1, c); set(x, y, c);
  };
  gem(3, 12, 'E', 'F'); gem(12, 11, '4', '2'); gem(8, 6, 'B', '2'); gem(5, 6, 'E', 'F');
});
ART.dragonlair = drawArt(32, 32, ({ rect, set, line, ellipse }) => {
  for (let y = 6; y <= 31; y++) {               // volcano
    const half = Math.floor(4 + (y - 6) * 0.48);
    rect(16 - half, y, half + 1, 1, '5');
    rect(17, y, half, 1, 'C');
    set(15 - half, y, '0'); set(17 + half, y, '0');
  }
  rect(12, 5, 9, 2, '3'); rect(13, 5, 7, 1, '7'); set(15, 4, '7'); set(16, 4, '8'); set(17, 4, '7'); // crater
  line(14, 7, 9, 21, '3'); line(15, 7, 10, 21, '7'); line(19, 7, 23, 18, '3'); // lava flows
  ellipse(16, 31.5, 6.5, 7, '0', '0', 31);      // cave
  set(13, 28, '8'); set(14, 28, '8'); set(18, 28, '8'); set(19, 28, '8'); // glowing eyes
  set(14, 28, '3'); set(18, 28, '3');
  for (const [x, y] of [[16, 2], [15, 1], [17, 1], [16, 0], [14, 3], [18, 2]]) set(x, y, '1'); // smoke
  for (const [x, y] of [[9, 31], [10, 31], [22, 31], [23, 30], [24, 31]]) set(x, y, '8'); // gold
});

// ---- Town Hall (2x2, centre of every biome) ----
ART.townhall = drawArt(32, 32, ({ box, rect, tri, set }) => {
  box(12, 4, 8, 11, '2', '0');                  // clock tower
  tri(16, 0, 4, 'D', '0', 1.25);                // tower roof
  set(16, 0, '8');                              // gold finial
  box(13, 6, 6, 6, '8');                        // clock face
  set(15, 8, '0'); set(16, 8, '0'); set(16, 7, '0'); set(16, 9, '0'); // hands
  box(0, 12, 32, 4, '3');                       // red roof band
  rect(1, 13, 30, 1, '4');
  box(1, 15, 30, 15, '2', '0');                 // white stone hall
  for (const x of [4, 9, 21, 26]) { rect(x, 16, 2, 13, '1'); set(x, 16, 'F'); } // columns
  for (const x of [6, 23]) box(x, 18, 3, 5, 'E'); // windows (between columns)
  box(12, 20, 8, 10, '5');                      // big doors
  rect(16, 21, 1, 9, '0'); set(14, 25, '8'); set(17, 25, '8');
  rect(0, 29, 32, 3, '1'); rect(10, 28, 12, 1, '1'); rect(0, 31, 32, 1, '0'); // steps
});

// ---- Defense towers (16x24 so they stand tall over the tile) ----
function makeTowerArt(wall, trim, top) {
  return drawArt(16, 24, (p) => {
    const { box, rect } = p;
    box(3, 11, 10, 13, wall);                   // shaft
    for (let y = 14; y < 23; y += 3) rect(4, y, 8, 1, trim);
    rect(7, 12, 2, 3, '0');                     // arrow slit
    box(6, 18, 4, 6, 'C');                      // door
    box(1, 8, 14, 4, wall);                     // lookout platform
    rect(2, 10, 12, 1, trim);
    for (let x = 1; x < 15; x += 4) box(x, 5, 3, 4, wall); // battlements
    top(p);
  });
}
ART.archer = makeTowerArt('6', '5', ({ tri, set }) => {
  tri(8, 0, 4, '3', '0', 1.6);                  // red conical roof
  set(8, 0, '8');
});
ART.ballista = makeTowerArt('8', '7', ({ line, rect, set }) => {
  rect(7, 1, 2, 5, '5');                        // stock
  line(2, 4, 8, 1, '6'); line(8, 1, 14, 4, '6'); // bow arms
  line(2, 4, 8, 3, '2'); line(8, 3, 14, 4, '2'); // string
  set(8, 0, '1');                               // bolt tip
});
ART.frosttower = makeTowerArt('F', 'E', ({ rect, set }) => {
  rect(7, 0, 2, 6, 'E');                        // ice crystal spire
  set(7, 0, '2'); set(8, 1, '2');
  for (const [x, y] of [[6, 2], [9, 2], [5, 3], [10, 3], [6, 4], [9, 4]]) set(x, y, 'F');
});
ART.darttower = makeTowerArt('6', 'A', ({ ellipse, set }) => {
  ellipse(8, 4, 7.5, 3.5, 'A', '9', 6);         // leaf-thatch roof
  set(5, 2, 'B'); set(10, 3, 'B'); set(8, 1, 'B');
});
ART.magmacannon = makeTowerArt('C', '3', ({ box, rect, set }) => {
  box(3, 1, 8, 5, '1');                         // cannon housing
  rect(10, 2, 5, 3, '0'); rect(11, 3, 4, 1, '5'); // barrel
  set(15, 3, '7');                              // glowing muzzle
  set(6, 3, '7'); set(7, 3, '8');               // lava core
});

// ---- Raiders: two walk frames each, drawn facing right ----
const ENEMY_ART = {
  meadow: [0, 1].map((f) => drawArt(12, 14, ({ box, rect, set }) => { // Goblin
    box(3, 0, 6, 5, 'B');                       // head
    set(2, 1, 'B'); set(9, 1, 'B'); set(1, 0, 'B'); set(10, 0, 'B'); // pointy ears
    set(4, 2, '3'); set(7, 2, '3');             // red eyes
    rect(5, 3, 2, 1, '0');
    box(3, 5, 6, 5, '6');                       // tunic
    rect(4, 8, 4, 1, '5');                      // belt
    set(2, 6, 'B'); set(9, 6, 'B');             // hands
    rect(1, 2, 1, 5, '5'); rect(0, 1, 2, 2, '6'); // club
    if (f) { rect(3, 10, 2, 3, 'A'); rect(7, 10, 2, 2, 'A'); set(3, 13, '0'); set(4, 13, '0'); }
    else { rect(4, 10, 2, 3, 'A'); rect(6, 10, 2, 3, 'A'); set(4, 13, '0'); set(7, 13, '0'); }
  })),
  desert: [0, 1].map((f) => drawArt(14, 10, ({ ellipse, line, rect, set }) => { // Scorpion
    ellipse(6, 6.5, 4.5, 2.2, '7', '0');        // body
    set(8, 6, '0');                             // eye
    line(2, 6, 1, 3, '7'); line(1, 3, 2, 1, '7'); // tail curling over the back
    set(3, 1, '7'); set(4, 2, '3'); set(3, 0, '0'); // stinger
    rect(12, 4, 2, 2, '7'); set(13, 4, '0'); set(11, 5, '7'); // claws
    rect(12, 7, 2, 2, '7'); set(13, 8, '0'); set(11, 7, '7');
    for (let i = 0; i < 4; i++) set(3 + i * 2 + f, 9, '5'); // legs
  })),
  tundra: [0, 1].map((f) => drawArt(12, 14, ({ box, rect, set }) => { // Yeti
    box(2, 0, 8, 6, '2', '1');                  // furry head
    rect(4, 2, 4, 3, 'E');                      // blue face
    set(4, 2, '0'); set(7, 2, '0');             // eyes
    set(5, 4, '2'); set(6, 4, '2');             // fangs
    box(1, 5, 10, 6, '2', '1');                 // body
    rect(3, 6, 6, 4, 'F');                      // belly
    rect(0, 6, 1, 4, '2'); rect(11, 6, 1, 4, '2'); // arms
    if (f) { rect(2, 11, 3, 2, '2'); rect(7, 11, 3, 3, '2'); }
    else { rect(2, 11, 3, 3, '2'); rect(7, 11, 3, 2, '2'); }
  })),
  jungle: [0, 1].map((f) => drawArt(14, 12, ({ box, rect, line, set }) => { // Raptor
    box(9, 0, 5, 4, 'A');                       // head
    set(11, 1, '8');                            // eye
    set(12, 3, '2');                            // teeth
    box(4, 3, 7, 5, 'A');                       // body
    rect(5, 5, 5, 1, 'B');                      // stripe
    line(0, 3, 4, 5, 'A'); line(0, 4, 4, 6, '9'); // tail
    set(10, 5, '9');                            // little arm
    if (f) { line(5, 8, 4, 11, '9'); line(8, 8, 9, 11, '9'); }
    else { line(6, 8, 6, 11, '9'); line(8, 8, 8, 11, '9'); }
  })),
  volcano: [0, 1].map((f) => drawArt(14, 14, ({ box, rect, set }) => { // Fire Golem
    box(4, 0, 6, 5, '1');                       // head
    set(5, 2, '8'); set(8, 2, '8');             // glowing eyes
    box(1, 4, 12, 6, 'C');                      // rocky body
    for (const [x, y, c] of [[4, 5, '7'], [5, 6, '3'], [6, 7, '7'], [9, 5, '3'], [9, 6, '7'], [8, 8, '3']]) set(x, y, c);
    rect(0, 5, 2, 5, '1'); rect(12, 5, 2, 5, '1'); // arms
    if (f) { rect(3, 10, 3, 3, '1'); rect(8, 10, 3, 4, '1'); }
    else { rect(3, 10, 3, 4, '1'); rect(8, 10, 3, 3, '1'); }
  })),
};

// ---- Villagers: two walk frames with placeholder colours H(air) S(kin) T(shirt) P(ants) ----
const WALKER_FRAMES = [
  [ // standing
    '..000..',
    '.0HHH0.',
    '.0HSS0.',
    '.0SSS0.',
    '0TTTTT0',
    '0TTTTT0',
    '0STTTS0',
    '.0PPP0.',
    '.0P0P0.',
    '.0P0P0.',
    '.00.00.',
  ],
  [ // mid-stride
    '..000..',
    '.0HHH0.',
    '.0HSS0.',
    '.0SSS0.',
    '0TTTTT0',
    '0TTTTT0',
    '0STTTS0',
    '.0PPP0.',
    '0PP0PP0',
    '0P0.0P0',
    '00...00',
  ],
];
const WALKER_LOOKS = [
  { H: '5', S: '7', T: '3', P: '9' },
  { H: '0', S: '6', T: 'D', P: 'C' },
  { H: '8', S: '7', T: 'A', P: '5' },
  { H: '6', S: '7', T: 'E', P: '9' },
  { H: '0', S: '7', T: '4', P: 'D' },
  { H: '5', S: '6', T: '8', P: 'C' },
  { H: '3', S: '7', T: 'B', P: '5' },
  { H: '1', S: '7', T: '2', P: 'D' },
];
const WALKER_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Pads rows to equal width so a typo can't break texture generation. */
function normalizeArt(rows) {
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => r.padEnd(w, '.'));
}

/**
 * Joins tiles into one horizontal strip with a 1-art-pixel extruded border
 * around each tile. Prevents texture bleeding / seams at fractional zoom.
 */
function buildExtrudedStrip(tiles) {
  const ext = (row) => row[0] + row + row[row.length - 1];
  const h = tiles[0].length;
  const rows = [tiles.map((t) => ext(t[0])).join('')];
  for (let y = 0; y < h; y++) rows.push(tiles.map((t) => ext(t[y])).join(''));
  rows.push(tiles.map((t) => ext(t[h - 1])).join(''));
  return rows;
}

const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
const fmt = (n) => n.toLocaleString('en-US');
/** Compact big numbers: 1500 -> 1,500, 2.5e6 -> 2.5M, 1e14 -> 100T, huge -> 1.23e+40. */
const short = (n) => {
  const a = Math.abs(n);
  if (!Number.isFinite(n) || a >= 1e33) return n.toExponential(2);
  for (const [v, s] of [[1e30, 'No'], [1e27, 'Oc'], [1e24, 'Sp'], [1e21, 'Sx'], [1e18, 'Qi'],
    [1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M']]) {
    if (a >= v) return `${+(n / v).toFixed(a >= v * 100 ? 0 : 2)}${s}`;
  }
  return fmt(n);
};

/* ==========================================================================
 * 4. GameState — the simulation. Knows nothing about Phaser or the DOM.
 * ======================================================================== */
class GameState {
  constructor(bus) {
    this.bus = bus;
    this.coins = CONFIG.START_COINS;
    this.materials = CONFIG.START_MATERIALS;
    this.population = 0;
    this.happiness = CONFIG.BASE_HAPPINESS;
    this.ticks = 0;
    this.tickLevel = 0; // index into CONFIG.TICK_LEVELS

    // One tile grid per biome (tile -> structure). Structures remember their biome.
    this.grids = Object.fromEntries(BIOMES.map((b) => [b.id, new Array(b.size * b.size).fill(null)]));
    this.activeBiome = BIOMES[0].id;
    this.unlockedBiomes = new Set([BIOMES[0].id]);
    this.structures = new Set();
    this.counts = Object.create(null);
    this.projection = { coins: 0, materials: 0 };
    this.unlockedTiers = new Set(); // tier ids unlocked via the Tech Tree
    this.upgrades = Object.create(null); // upgrade id -> level bought
    this.seed = Math.random().toString(36).slice(2); // keeps terrain identical across reloads

    // Defense & raids
    this.towers = new Set();             // structures with a `tower` def
    this.halls = Object.create(null);    // biome id -> Town Hall structure
    this.enemies = [];                   // live raiders in every biome
    this.enemySeq = 0;
    this.lost = false;
    this.raidsWon = 0;
    this.raidMode = 'auto';              // 'auto' = timed raids, 'manual' = only when you call them
    this.raids = Object.fromEntries(BIOMES.map((b, i) => [
      b.id, this._newRaid(CONFIG.RAID_FIRST_MS + i * CONFIG.RAID_STAGGER_MS),
    ]));
  }

  _newRaid(timer, wave = 0) {
    return {
      wave, timer, warned: false, active: false, called: false,
      enemy: null, // the mutated raider def for the wave being fought
      toSpawn: 0, spawnT: 0, alive: 0, leaked: 0, earlyMs: 0, angle: 0, radius: 0, hallHp: CONFIG.HALL_HP,
    };
  }

  /* ---------- Save / load ---------- */
  serialize() {
    const structures = [];
    for (const s of this.structures) {
      structures.push(s.level > 1 && !TOWER_UPGRADE_OF[s.type]
        ? [s.type, s.tx, s.ty, s.biome, s.level]
        : [s.type, s.tx, s.ty, s.biome]);
    }
    return {
      version: 1,
      savedAt: Date.now(),
      seed: this.seed,
      mapSize: CONFIG.MAP_W,
      coins: this.coins,
      materials: this.materials,
      population: this.population,
      ticks: this.ticks,
      tickLevel: this.tickLevel,
      unlockedTiers: [...this.unlockedTiers],
      upgrades: { ...this.upgrades },
      activeBiome: this.activeBiome,
      unlockedBiomes: [...this.unlockedBiomes],
      raidsWon: this.raidsWon,
      raidMode: this.raidMode,
      // An unfinished raid restarts (with a fresh warning) after loading.
      raids: Object.fromEntries(BIOMES.map((b) => {
        const r = this.raids[b.id];
        return [b.id, { wave: r.wave, timer: Math.round(r.active ? CONFIG.RAID_WARN_MS + 5000 : r.timer) }];
      })),
      structures,
    };
  }

  /** Restore from serialize() output. Invalid entries are skipped, never thrown. */
  load(data) {
    if (!data || data.version !== 1) return false;
    const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

    this.seed = typeof data.seed === 'string' ? data.seed : this.seed;
    this.coins = num(data.coins, CONFIG.START_COINS);
    this.materials = num(data.materials, CONFIG.START_MATERIALS);
    this.ticks = num(data.ticks, 0);
    this.tickLevel = clamp(num(data.tickLevel, 0), 0, CONFIG.TICK_LEVELS.length - 1);
    this.unlockedTiers = new Set((data.unlockedTiers || []).filter((id) => TIER_BY_ID[id]));
    const savedUpgrades = { ...(data.upgrades || {}) };
    // The archer-only upgrade became the all-towers upgrade.
    if (savedUpgrades.towers === undefined && savedUpgrades.archers !== undefined) savedUpgrades.towers = savedUpgrades.archers;
    for (const u of UPGRADES) {
      const lvl = Math.floor(clamp(num(savedUpgrades[u.id], 0), 0, u.costs.length));
      if (lvl) this.upgrades[u.id] = lvl;
    }

    for (const id of data.unlockedBiomes || []) if (BIOME_BY_ID[id]) this.unlockedBiomes.add(id);
    if (this.unlockedBiomes.has(data.activeBiome)) this.activeBiome = data.activeBiome;

    // Older saves used a smaller Meadow: shift them so they stay centred in the new one.
    const oldSize = num(data.mapSize, CONFIG.LEGACY_MAP_SIZE);
    const shift = Math.floor((CONFIG.MAP_W - oldSize) / 2);

    const legacyShared = Object.create(null); // per-tower levels saved before shared upgrades existed
    for (const [type, rawX, rawY, rawBiome, rawLevel] of data.structures || []) {
      const def = TOOL_BY_ID[type];
      if (!def || def.kind !== 'build') continue;
      const biome = BIOME_BY_ID[rawBiome] ? rawBiome : 'meadow'; // pre-biome saves
      if (!this.unlockedBiomes.has(biome) || (def.biome && def.biome !== biome)) continue;
      const off = biome === 'meadow' ? shift : 0;
      const tx = rawX + off;
      const ty = rawY + off;
      if (!this._areaFree(def, tx, ty, biome)) continue;
      if (def.hall && this.halls[biome]) continue; // only one Town Hall per biome
      const s = { type, def, biome, tx, ty, w: def.w, h: def.h, view: null };
      if (def.tower) s.level = Math.floor(num(rawLevel, 1));
      const shared = TOWER_UPGRADE_OF[type];
      if (shared) legacyShared[shared] = Math.max(legacyShared[shared] || 1, s.level);
      this._register(s);
    }
    // Carry old per-tower levels over to the shared town upgrade so nothing bought is lost.
    for (const [id, lvl] of Object.entries(legacyShared)) {
      if (this.upgradeLevel(id) || lvl < 2) continue;
      this.upgrades[id] = Math.min(UPGRADE_BY_ID[id].costs.length, lvl - 1);
      this._refreshSharedTowers(id);
    }

    this.raidsWon = Math.max(0, Math.floor(num(data.raidsWon, 0)));
    this.raidMode = data.raidMode === 'manual' ? 'manual' : 'auto';
    const savedRaids = data.raids || {};
    for (const b of BIOMES) {
      const r = savedRaids[b.id];
      if (!r) continue;
      const wave = Math.max(0, Math.floor(num(r.wave, 0)));
      const timer = clamp(num(r.timer, CONFIG.RAID_FIRST_MS), 10000, CONFIG.RAID_MAX_MS + CONFIG.RAID_FIRST_MS);
      this.raids[b.id] = this._newRaid(timer, wave);
    }

    this.grantLandForExisting();
    this.population = clamp(num(data.population, 0), 0, this.capacity);
    this.recalculate();

    // Offline earnings: a share of the current per-tick yield for the time away.
    const away = clamp(Date.now() - num(data.savedAt, Date.now()), 0, CONFIG.OFFLINE_MAX_MS);
    const ticks = Math.floor(away / this.tickMs);
    if (ticks > 0) {
      const coins = Math.floor(this.projection.coins * ticks * CONFIG.OFFLINE_RATE);
      const materials = Math.floor(this.projection.materials * ticks * CONFIG.OFFLINE_RATE);
      if (coins > 0 || materials > 0) {
        this.coins += coins;
        this.materials += materials;
        this.offlineReport = { coins, materials, ms: away };
        this.recalculate();
      }
    }
    return true;
  }

  /** Old saves may have buildings outside the starting land: grant enough land for free. */
  grantLandForExisting() {
    const M = CONFIG.MAP_W;
    let need = CONFIG.LAND_START;
    for (const s of this.structures) {
      if (s.biome !== 'meadow') continue; // land expansion only applies to the Meadow
      need = Math.max(need, M - 2 * s.tx, 2 * (s.tx + s.w) - M, M - 2 * s.ty, 2 * (s.ty + s.h) - M);
    }
    const u = UPGRADE_BY_ID.land;
    const lvl = Math.min(u.costs.length, Math.ceil((need - CONFIG.LAND_START) / u.per));
    if (lvl > this.upgradeLevel('land')) this.upgrades.land = lvl;
  }

  _areaFree(def, tx, ty, biome = this.activeBiome) {
    for (let y = ty; y < ty + def.h; y++) {
      for (let x = tx; x < tx + def.w; x++) {
        if (!this.inBounds(x, y, biome) || this.at(x, y, biome)) return false;
      }
    }
    return true;
  }

  /* ---------- Queries ---------- */
  /** Map side length (tiles) of a biome. */
  sizeOf(biome = this.activeBiome) { return BIOME_BY_ID[biome].size; }
  inBounds(tx, ty, biome = this.activeBiome) {
    const n = this.sizeOf(biome);
    return tx >= 0 && ty >= 0 && tx < n && ty < n;
  }
  /** Side length (tiles) of the centred buildable area in the Meadow. */
  get landSize() { return Math.min(CONFIG.MAP_W, CONFIG.LAND_START + this.upgradeBonus('land')); }
  /** Buildable rectangle in tiles: { x, y, size }. Only the Meadow is limited by land expansion. */
  landRectOf(biome) {
    if (biome !== 'meadow') return { x: 0, y: 0, size: this.sizeOf(biome) };
    const size = this.landSize;
    const off = Math.floor((CONFIG.MAP_W - size) / 2);
    return { x: off, y: off, size };
  }
  get landRect() { return this.landRectOf(this.activeBiome); }
  isOwned(tx, ty, biome = this.activeBiome) {
    const r = this.landRectOf(biome);
    return tx >= r.x && ty >= r.y && tx < r.x + r.size && ty < r.y + r.size;
  }
  at(tx, ty, biome = this.activeBiome) {
    return this.inBounds(tx, ty, biome) ? this.grids[biome][ty * this.sizeOf(biome) + tx] : null;
  }
  /** Road structures in one biome (walkers use these). */
  roadsIn(biome = this.activeBiome) {
    const out = [];
    for (const s of this.structures) if (s.biome === biome && s.def.isRoad) out.push(s);
    return out;
  }
  count(type) { return this.counts[type] || 0; }
  /** Housing from every residential building (houses, apartments), plus upgrades. */
  get capacity() {
    const extra = this.upgradeBonus('housing');
    let cap = 0;
    for (const t of TOOLS) if (t.residents) cap += this.count(t.id) * (t.residents + extra);
    return cap;
  }
  upgradeLevel(id) { return this.upgrades[id] || 0; }
  /** Total bonus from an upgrade: level * per-level amount. */
  upgradeBonus(id) { return this.upgradeLevel(id) * UPGRADE_BY_ID[id].per; }
  /** Coins for an upgrade's next level, or null when maxed. */
  nextUpgradeCost(id) {
    const u = UPGRADE_BY_ID[id];
    const lvl = this.upgradeLevel(id);
    return lvl < u.costs.length ? u.costs[lvl] : null;
  }
  /** Output multiplier for buildings not touching a road. */
  get unconnectedFactor() { return Math.min(1, CONFIG.UNCONNECTED_FACTOR + this.upgradeBonus('paths')); }
  get tickMs() { return CONFIG.TICK_LEVELS[this.tickLevel]; }
  /** Coins for the next tick-speed level, or null when maxed. */
  get nextTickCost() {
    return this.tickLevel < CONFIG.TICK_UPGRADE_COSTS.length ? CONFIG.TICK_UPGRADE_COSTS[this.tickLevel] : null;
  }

  canAfford(cost) { return this.coins >= cost.coins && this.materials >= cost.materials; }

  /** Is this tool's tech-tree tier unlocked (or is it a free utility tool)? */
  isToolUnlocked(id) {
    if (ALWAYS_UNLOCKED.has(id)) return true;
    const t = TOOL_BY_ID[id];
    if (t && t.biome && t.biome !== 'meadow') return this.unlockedBiomes.has(t.biome);
    const tier = TIER_OF_TOOL[id];
    return tier ? this.unlockedTiers.has(tier.id) : true;
  }

  /** @returns {string|null} error message, or null if placement is valid */
  checkPlacement(def, tx, ty) {
    if (def.biome && def.biome !== this.activeBiome) return ERR.BIOME;
    if (!this.isToolUnlocked(def.id)) return ERR.LOCKED;
    for (let y = ty; y < ty + def.h; y++) {
      for (let x = tx; x < tx + def.w; x++) {
        if (!this.inBounds(x, y)) return ERR.BOUNDS;
        if (this.at(x, y)) return ERR.OCCUPIED;
        if (!this.isOwned(x, y)) return ERR.LAND;
      }
    }
    if (this.coins < def.cost.coins) return ERR.COINS;
    if (this.materials < def.cost.materials) return ERR.MATERIALS;
    return null;
  }

  isRoad(tx, ty, biome = this.activeBiome) {
    const s = this.at(tx, ty, biome);
    return !!s && s.def.isRoad;
  }

  /** A structure is connected if any tile along its perimeter is a road (in its own biome). */
  isConnected(s) {
    if (s.def.isRoad) return true;
    const b = s.biome;
    for (let x = s.tx; x < s.tx + s.w; x++) {
      if (this.isRoad(x, s.ty - 1, b) || this.isRoad(x, s.ty + s.h, b)) return true;
    }
    for (let y = s.ty; y < s.ty + s.h; y++) {
      if (this.isRoad(s.tx - 1, y, b) || this.isRoad(s.tx + s.w, y, b)) return true;
    }
    return false;
  }

  /* ---------- Mutations ---------- */
  place(def, tx, ty) {
    const error = this.checkPlacement(def, tx, ty);
    if (error) return { error };

    this.coins -= def.cost.coins;
    this.materials -= def.cost.materials;

    const s = { type: def.id, def, biome: this.activeBiome, tx, ty, w: def.w, h: def.h, view: null };
    this._register(s);

    this.recalculate();
    return { structure: s };
  }

  remove(tx, ty) {
    const s = this.at(tx, ty);
    if (!s) return null;
    if (s.def.hall) return { blocked: true, structure: s };

    this._unregister(s);

    const refund = Math.floor(this._spentCoins(s) * CONFIG.REFUND_RATE);
    this.coins += refund;
    this.population = Math.min(this.population, this.capacity);

    this.recalculate();
    return { structure: s, refund };
  }

  _fill(s, value) {
    const n = this.sizeOf(s.biome);
    const grid = this.grids[s.biome];
    for (let y = s.ty; y < s.ty + s.h; y++) {
      for (let x = s.tx; x < s.tx + s.w; x++) grid[y * n + x] = value;
    }
  }

  /** Add a structure to the grid and every index that tracks it. */
  _register(s) {
    this._fill(s, s);
    this.structures.add(s);
    this.counts[s.type] = this.count(s.type) + 1;
    if (s.def.tower) {
      this.towers.add(s);
      this._setTowerLevel(s, s.level || 1);
    }
    if (s.def.hall) this.halls[s.biome] = s;
  }

  /* ---------- Tower upgrades ---------- */
  /** Every defense tower uses the shared Defense Towers upgrade level. */
  _setTowerLevel(s, level) {
    const shared = TOWER_UPGRADE_OF[s.type];
    s.level = clamp(shared ? 1 + this.upgradeLevel(shared) : level, 1, CONFIG.TOWER_MAX_LEVEL);
    s.stats = towerStatsAt(s.def.tower, s.level);
  }

  _refreshSharedTowers(upgradeId) {
    for (const s of this.towers) if (TOWER_UPGRADE_OF[s.type] === upgradeId) this._setTowerLevel(s);
  }

  /** Coins + wood to take a tower to its next level, or null when maxed / not a tower. */
  towerUpgradeCost(s) {
    if (!s.def.tower || s.level >= CONFIG.TOWER_MAX_LEVEL) return null;
    const shared = TOWER_UPGRADE_OF[s.type];
    if (shared) {
      const coins = this.nextUpgradeCost(shared);
      return coins === null ? null : { coins, materials: 0 };
    }
    const mult = CONFIG.TOWER_UPGRADE_COST[s.level - 1];
    return { coins: Math.round(s.def.cost.coins * mult), materials: Math.round(s.def.cost.materials * mult) };
  }

  upgradeTower(s) {
    if (!s || !s.def.tower || !this.structures.has(s)) return { error: 'Select a defense tower first' };
    const cost = this.towerUpgradeCost(s);
    if (!cost) return { error: ERR.UPGRADE_MAXED };
    const shared = TOWER_UPGRADE_OF[s.type];
    if (shared) {
      const res = this.buyUpgrade(shared);
      return res.error ? res : { level: s.level, cost, shared: true };
    }
    if (this.coins < cost.coins) return { error: ERR.COINS };
    if (this.materials < cost.materials) return { error: ERR.MATERIALS };
    this.coins -= cost.coins;
    this.materials -= cost.materials;
    this._setTowerLevel(s, s.level + 1);
    this.recalculate();
    return { level: s.level, cost };
  }

  /** Coins sunk into a structure (build cost + its own tower upgrades); refunds are based on this. */
  _spentCoins(s) {
    let coins = s.def.cost.coins;
    if (TOWER_UPGRADE_OF[s.type]) return coins; // town-wide upgrades aren't refunded per tower
    for (let l = 1; l < (s.level || 1); l++) coins += Math.round(s.def.cost.coins * CONFIG.TOWER_UPGRADE_COST[l - 1]);
    return coins;
  }

  _unregister(s) {
    this._fill(s, null);
    this.structures.delete(s);
    this.counts[s.type]--;
    this.towers.delete(s);
  }

  /* ---------- Town Halls ---------- */
  /** Every unlocked biome gets a Town Hall at (or as near as possible to) its centre. */
  ensureHalls() {
    const placed = [];
    for (const id of this.unlockedBiomes) if (!this.halls[id]) placed.push(this.placeHall(id));
    if (placed.length) this.recalculate();
    return placed;
  }

  placeHall(biome) {
    const n = this.sizeOf(biome);
    const c = Math.floor(n / 2) - 1;
    const fits = (x, y) => this._areaFree(TOWN_HALL, x, y, biome)
      && this.isOwned(x, y, biome) && this.isOwned(x + 1, y + 1, biome);
    // Search outward ring by ring from the centre (old saves may have built there).
    for (let d = 0; d < n; d++) {
      for (let y = c - d; y <= c + d; y++) {
        for (let x = c - d; x <= c + d; x++) {
          if (Math.max(Math.abs(x - c), Math.abs(y - c)) !== d) continue;
          if (fits(x, y)) return this._addHall(biome, x, y);
        }
      }
    }
    // Land completely full: clear the centre (full refund) to make room.
    for (let y = c; y < c + 2; y++) {
      for (let x = c; x < c + 2; x++) {
        const s = this.at(x, y, biome);
        if (!s) continue;
        this._unregister(s);
        this.coins += this._spentCoins(s);
        s.evicted = true;
      }
    }
    return this._addHall(biome, c, c);
  }

  _addHall(biome, tx, ty) {
    const s = { type: TOWN_HALL.id, def: TOWN_HALL, biome, tx, ty, w: 2, h: 2, view: null };
    this._register(s);
    return s;
  }

  /** Centre of a biome's Town Hall in tile units. */
  hallCenter(biome) {
    const h = this.halls[biome];
    return h ? { x: h.tx + h.w / 2, y: h.ty + h.h / 2 } : { x: this.sizeOf(biome) / 2, y: this.sizeOf(biome) / 2 };
  }

  /** Remove every structure in one biome, refunding like the bulldozer. Coins/upgrades/tech are kept. */
  clearBiome(biome = this.activeBiome) {
    const removed = [];
    for (const s of this.structures) if (s.biome === biome && !s.def.hall) removed.push(s);
    let refund = 0;
    for (const s of removed) {
      refund += Math.floor(this._spentCoins(s) * CONFIG.REFUND_RATE);
      this._unregister(s);
    }
    this.coins += refund;
    this.population = Math.min(this.population, this.capacity);
    this.recalculate();
    return { removed, refund };
  }

  /* ---------- Biomes ---------- */
  /** Spend coins to unlock the next biome (must be bought in order). */
  unlockBiome(id) {
    const b = BIOME_BY_ID[id];
    if (!b) return { error: 'Unknown biome' };
    if (this.unlockedBiomes.has(id)) return { error: ERR.BIOME_DONE };
    const prev = BIOMES[BIOMES.indexOf(b) - 1];
    if (prev && !this.unlockedBiomes.has(prev.id)) return { error: ERR.BIOME_ORDER };
    if (this.coins < b.cost) return { error: ERR.COINS };
    this.coins -= b.cost;
    this.unlockedBiomes.add(id);
    this.placeHall(id);
    this.raids[id] = this._newRaid(CONFIG.RAID_FIRST_MS);
    this.recalculate();
    return { biome: b };
  }

  /** Switch which biome is shown & built in. Every biome keeps earning either way. */
  setBiome(id) {
    if (!this.unlockedBiomes.has(id)) return false;
    this.activeBiome = id;
    this.recalculate();
    return true;
  }

  biomeStatus() {
    return BIOMES.map((b, i) => ({
      id: b.id, name: b.name, icon: b.icon, size: b.size, cost: b.cost,
      unlocked: this.unlockedBiomes.has(b.id),
      available: i === 0 || this.unlockedBiomes.has(BIOMES[i - 1].id),
      affordable: this.coins >= b.cost,
      active: b.id === this.activeBiome,
      raiding: this.raids[b.id].active,
      wave: this.raids[b.id].wave,
      raider: this.raiderOf(b.id).plural,
    }));
  }

  /* ---------- Upgrades ---------- */
  upgradeTickSpeed() {
    const cost = this.nextTickCost;
    if (cost === null) return { error: ERR.MAXED };
    if (this.coins < cost) return { error: ERR.COINS };
    this.coins -= cost;
    this.tickLevel++;
    this.recalculate();
    return { ms: this.tickMs };
  }

  /** Buy the next level of a town upgrade (see UPGRADES). */
  buyUpgrade(id) {
    const u = UPGRADE_BY_ID[id];
    if (!u) return { error: 'Unknown upgrade' };
    const cost = this.nextUpgradeCost(id);
    if (cost === null) return { error: ERR.UPGRADE_MAXED };
    if (this.coins < cost) return { error: ERR.COINS };
    this.coins -= cost;
    this.upgrades[id] = this.upgradeLevel(id) + 1;
    if (u.towers) this._refreshSharedTowers(id);
    this.recalculate();
    return { upgrade: u, level: this.upgrades[id] };
  }

  /** Snapshot of every upgrade (tick speed first) for the Upgrades UI. */
  upgradeStatus() {
    const secs = (ms) => `${(ms / 1000).toFixed(1)}s/tick`;
    const tickCost = this.nextTickCost;
    const list = [{
      id: 'tick', name: 'Faster Ticks', icon: '\u23F1\uFE0F',
      desc: 'Economy ticks (income, wood, growth) happen more often.',
      level: this.tickLevel, max: CONFIG.TICK_UPGRADE_COSTS.length, cost: tickCost,
      now: secs(this.tickMs),
      next: tickCost === null ? null : secs(CONFIG.TICK_LEVELS[this.tickLevel + 1]),
    }];
    for (const u of UPGRADES) {
      const level = this.upgradeLevel(u.id);
      const cost = this.nextUpgradeCost(u.id);
      list.push({
        id: u.id, name: u.name, icon: u.icon, desc: u.desc,
        level, max: u.costs.length, cost,
        now: u.label(level * u.per),
        next: cost === null ? null : u.label((level + 1) * u.per),
      });
    }
    for (const item of list) item.affordable = item.cost !== null && this.coins >= item.cost;
    return list;
  }

  /** Spend coins to permanently unlock a Tech Tree tier (must be bought in order). */
  unlockTier(tierId) {
    const tier = TIER_BY_ID[tierId];
    if (!tier) return { error: 'Unknown tier' };
    if (this.unlockedTiers.has(tierId)) return { error: ERR.TIER_DONE };

    const idx = TIERS.indexOf(tier);
    const prev = TIERS[idx - 1];
    if (prev && !this.unlockedTiers.has(prev.id)) return { error: ERR.TIER_LOCKED };
    if (this.coins < tier.cost) return { error: ERR.COINS };

    this.coins -= tier.cost;
    this.unlockedTiers.add(tierId);
    this.recalculate();
    return { tier };
  }

  /** Snapshot of every tier's lock/affordability state, for the Tech Tree UI. */
  techStatus() {
    return TIERS.map((t, i) => ({
      id: t.id,
      name: t.name,
      cost: t.cost,
      buildings: t.buildings,
      unlocked: this.unlockedTiers.has(t.id),
      available: i === 0 || this.unlockedTiers.has(TIERS[i - 1].id),
      affordable: this.coins >= t.cost,
    }));
  }

  /* ---------- Raids & defense ---------- */
  /** Advance raids in every unlocked biome by dt ms (called every frame). */
  updateRaids(dt) {
    if (this.lost) return;
    for (const id of this.unlockedBiomes) {
      this._updateRaidTimer(id, dt);
      if (this.lost) return;
    }
    this._updateEnemies(dt);
    if (this.lost) return;
    this._updateTowers(dt);
  }

  _updateRaidTimer(id, dt) {
    const r = this.raids[id];
    if (r.active) {
      if (r.toSpawn > 0) {
        r.spawnT -= dt;
        if (r.spawnT <= 0) {
          r.spawnT += CONFIG.RAID_SPAWN_MS;
          r.toSpawn--;
          this._spawnEnemy(id, r);
        }
      } else if (r.alive <= 0) {
        this._endRaid(id);
      }
      return;
    }
    // On-demand mode: the clock stops, raids only happen when you call them.
    if (this.raidMode === 'manual') return;
    r.timer -= dt;
    if (!r.warned && r.timer <= CONFIG.RAID_WARN_MS) {
      r.warned = true;
      this.bus.emit('raid:warning', { biome: id, enemy: this.raiderOf(id), secs: Math.ceil(Math.max(0, r.timer) / 1000) });
    }
    if (r.timer <= 0) this._startRaid(id);
  }

  /** The raider this biome will field next (or is fielding right now). */
  raiderOf(biome) {
    const r = this.raids[biome];
    return (r.active && r.enemy) || raiderFor(biome, r.wave);
  }

  /** Switch between timed raids and on-demand ones. Returns the new mode. */
  setRaidMode(mode) {
    this.raidMode = mode === 'manual' ? 'manual' : 'auto';
    this.bus.emit('raid:mode', { mode: this.raidMode });
    return this.raidMode;
  }

  toggleRaidMode() {
    return this.setRaidMode(this.raidMode === 'manual' ? 'auto' : 'manual');
  }

  /**
   * Start a biome's next raid right now. Calling it in before it was due pays
   * a bravery bonus of up to RAID_EARLY_BONUS extra coins.
   * Returns { ok, reason }.
   */
  callRaid(biome = this.activeBiome) {
    if (this.lost) return { ok: false, reason: 'lost' };
    if (!this.unlockedBiomes.has(biome)) return { ok: false, reason: 'locked' };
    const r = this.raids[biome];
    if (r.active) return { ok: false, reason: 'active' };
    r.called = true;
    // Keep whatever is left on the clock: it decides the early-call bonus.
    r.timer = Math.max(0, r.timer);
    r.warned = true;
    const enemy = raiderFor(biome, r.wave);
    this.bus.emit('raid:warning', {
      biome, enemy, called: true,
      secs: Math.ceil(CONFIG.RAID_CALL_LEAD_MS / 1000),
    });
    this._startRaid(biome);
    return { ok: true, enemy, bonus: this._earlyBonus(r) };
  }

  /** Coin bonus for starting a raid ahead of schedule (0 when it was due anyway). */
  _earlyBonus(r) {
    if (!r.called) return 0;
    const share = clamp(r.earlyMs / CONFIG.RAID_MIN_MS, 0, 1);
    return Math.round(CONFIG.RAID_REWARD * CONFIG.RAID_EARLY_BONUS * share);
  }

  /** Farthest distance (tiles) from the Town Hall to anything built in a biome. */
  _villageRadius(biome) {
    const c = this.hallCenter(biome);
    let r = 0;
    for (const s of this.structures) {
      if (s.biome !== biome) continue;
      r = Math.max(r, Math.abs(s.tx + s.w / 2 - c.x), Math.abs(s.ty + s.h / 2 - c.y));
    }
    return r;
  }

  _startRaid(id) {
    const r = this.raids[id];
    const e = raiderFor(id, r.wave);
    r.enemy = e;
    r.active = true;
    r.alive = 0;
    r.leaked = 0;
    r.earlyMs = r.called ? Math.max(0, r.timer) : 0; // how much of the clock you skipped
    // A called raid takes a few seconds to arrive, so you can still react.
    r.spawnT = r.called ? CONFIG.RAID_CALL_LEAD_MS : 0;
    r.hallHp = CONFIG.HALL_HP;
    r.toSpawn = e.count;
    r.angle = Math.random() * Math.PI * 2; // the whole raid comes from one direction
    // Raiders gather just outside the village, never beyond the map edge.
    r.radius = clamp(this._villageRadius(id) + 8, 12, this.sizeOf(id) / 2 - 1);
    this.bus.emit('raid:start', { biome: id, enemy: e, count: r.toSpawn, called: r.called });
    this.recalculate();
  }

  _spawnEnemy(id, r, from = null) {
    const def = r.enemy || raiderFor(id, r.wave);
    const c = this.hallCenter(id);
    const n = this.sizeOf(id);
    const a = r.angle + (Math.random() - 0.5) * 0.7;
    const hp = from ? Math.max(1, Math.round(from.maxHp * 0.4)) : def.hp;
    const scale = (def.scale || 1) * (from ? 0.7 : 1);
    this.enemies.push({
      id: ++this.enemySeq,
      biome: id,
      x: from ? from.x : clamp(c.x + Math.cos(a) * r.radius, 0.5, n - 0.5),
      y: from ? from.y : clamp(c.y + Math.sin(a) * r.radius, 0.5, n - 0.5),
      gx: c.x + (Math.random() - 0.5) * 0.8, // personal target so they don't stack
      gy: c.y + (Math.random() - 0.5) * 0.8,
      hp, maxHp: hp,
      speed: def.speed * (0.9 + Math.random() * 0.2) * (from ? 1.25 : 1),
      dmg: from ? Math.max(1, Math.round(def.dmg * 0.5)) : def.dmg,
      // Mutation traits
      tint: def.tint,
      scale,
      resist: def.resist,
      regen: def.regen,
      slowProof: def.slowProof,
      split: from ? 0 : def.split, // children never split again
      slowMs: 0, slow: 1,
      left: false,
      view: null,
    });
    r.alive++;
  }

  _removeEnemy(i, reason) {
    const e = this.enemies[i];
    this.enemies.splice(i, 1);
    this.raids[e.biome].alive--;
    this.bus.emit('enemy:removed', { enemy: e, reason });
  }

  _updateEnemies(dt) {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const c = this.hallCenter(e.biome);
      if (e.slowMs > 0) e.slowMs -= dt;
      if (e.regen && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + (e.maxHp * e.regen * dt) / 1000);
      const step = (e.speed * (e.slowMs > 0 ? e.slow : 1) * dt) / 1000;

      if (Math.hypot(c.x - e.x, c.y - e.y) <= CONFIG.HALL_REACH) {
        this._hitHall(e, i);
        if (this.lost) return;
        continue;
      }
      const dx = e.gx - e.x;
      const dy = e.gy - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      e.x += (dx / dist) * Math.min(step, dist);
      e.y += (dy / dist) * Math.min(step, dist);
      if (Math.abs(dx) > 0.05) e.left = dx < 0;
    }
  }

  _hitHall(e, i) {
    const r = this.raids[e.biome];
    r.hallHp = Math.max(0, r.hallHp - e.dmg);
    r.leaked++;
    this._removeEnemy(i, 'hit');
    this.bus.emit('raid:hit', { biome: e.biome, hp: r.hallHp, enemy: e });
    if (r.hallHp <= 0) {
      this.lost = true;
      this.bus.emit('gameover', { biome: e.biome, enemy: this.raiderOf(e.biome), raidsWon: this.raidsWon });
    }
  }

  _updateTowers(dt) {
    const enemies = this.enemies;
    for (const s of this.towers) {
      s.cd = Math.max(0, (s.cd || 0) - dt);
      if (s.cd > 0 || !enemies.length) continue;
      const t = s.stats;
      const cx = s.tx + s.w / 2;
      const cy = s.ty + s.h / 2;
      let best = null;
      let bestD = t.range * t.range;
      for (const e of enemies) {
        if (e.biome !== s.biome || e.hp <= 0) continue;
        const d = (e.x - cx) ** 2 + (e.y - cy) ** 2;
        if (d <= bestD) { bestD = d; best = e; }
      }
      if (!best) continue;
      s.cd = t.rate;
      this._damage(best, t.damage, t);
      if (t.splash) {
        for (const e of enemies) {
          if (e === best || e.biome !== s.biome || e.hp <= 0) continue;
          if ((e.x - best.x) ** 2 + (e.y - best.y) ** 2 <= t.splash * t.splash) this._damage(e, t.damage * 0.5, t);
        }
      }
      this.bus.emit('tower:shot', { tower: s, enemy: best });
    }
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].hp > 0) continue;
      const e = enemies[i];
      this._removeEnemy(i, 'killed');
      // Splitting raiders leave two smaller ones behind.
      if (e.split > 0) {
        const r = this.raids[e.biome];
        if (r.active) for (let n = 0; n < e.split; n++) this._spawnEnemy(e.biome, r, e);
      }
    }
  }

  _damage(e, amount, t) {
    e.hp -= amount * (e.resist || 1);
    if (t.slow && !e.slowProof) { e.slow = t.slow; e.slowMs = t.slowMs; }
  }

  _endRaid(id) {
    const r = this.raids[id];
    const beaten = r.enemy || raiderFor(id, r.wave);
    const bonus = r.leaked ? 0 : this._earlyBonus(r);
    r.active = false;
    r.enemy = null;
    r.called = false;
    r.earlyMs = 0;
    r.wave++;
    r.warned = false;
    r.hallHp = CONFIG.HALL_HP; // repaired between raids
    r.timer = CONFIG.RAID_MIN_MS + Math.random() * (CONFIG.RAID_MAX_MS - CONFIG.RAID_MIN_MS);
    // Only a fully defeated raid (no raider reached the Town Hall) pays out.
    const reward = r.leaked ? 0 : CONFIG.RAID_REWARD + bonus;
    if (reward) this.raidsWon++;
    this.coins += reward;
    // Survive and the survivors adapt: the next wave is a different breed.
    const next = raiderFor(id, r.wave);
    this.bus.emit('raid:won', { biome: id, enemy: beaten, next, reward, bonus, leaked: r.leaked });
    this.recalculate();
  }

  /** Compact raid info for the HUD (current biome + any others under attack). */
  raidSummary() {
    const id = this.activeBiome;
    const r = this.raids[id];
    const elsewhere = [...this.unlockedBiomes].filter((b) => b !== id && this.raids[b].active);
    return {
      active: r.active,
      left: r.alive + r.toSpawn,
      secs: Math.max(0, Math.ceil(r.timer / 1000)),
      hallHp: r.hallHp,
      enemy: this.raiderOf(id),
      wave: r.wave,
      mode: this.raidMode,
      canCall: !r.active && !this.lost,
      bonus: r.active ? 0 : Math.round(CONFIG.RAID_REWARD * CONFIG.RAID_EARLY_BONUS * clamp(r.timer / CONFIG.RAID_MIN_MS, 0, 1)),
      elsewhere: elsewhere.map((b) => BIOME_BY_ID[b].name),
    };
  }

  /* ---------- Economy ---------- */
  computeHappiness() {
    let h = CONFIG.BASE_HAPPINESS;
    let unconnectedHomes = 0;

    for (const s of this.structures) {
      h += s.def.happiness;
      if (s.type === 'house' && !this.isConnected(s)) unconnectedHomes++;
    }

    // Shops nearby make villagers happy: -10 with no shops, +10 when well served.
    const houses = this.count('house');
    if (houses > 0) {
      const coverage = Math.min(1, (this.count('shop') * CONFIG.HOUSES_PER_SHOP) / houses);
      h += Math.round(coverage * 20) - 10;
    }

    h -= unconnectedHomes * 2;
    h += this.upgradeBonus('festival');
    return clamp(Math.round(h), 0, 100);
  }

  /** Town-wide multipliers shared by every structure in a tick. */
  yieldContext() {
    let customersNeeded = 0;
    let power = 0;
    for (const t of TOOLS) {
      const n = this.count(t.id);
      customersNeeded += n * t.customers;
      power += n * t.power;
    }
    const demand = customersNeeded ? Math.min(1, this.population / customersNeeded) : 0;
    return {
      mult: (0.5 + this.happiness / 100) // happiness 0.5x..1.5x
        * (1 + Math.min(CONFIG.MAX_POWER_BONUS, power))
        * (1 + this.upgradeBonus('coins')),
      commerce: (0.25 + 0.75 * demand) // commercial buildings never fully stall
        * (1 + this.upgradeBonus('commerce')),
      wood: 1 + this.upgradeBonus('wood'),
      offRoad: this.unconnectedFactor,
    };
  }

  /** Coins & materials one structure produces per tick. */
  structureYield(s, ctx = this.yieldContext()) {
    const d = s.def;
    const link = this.isConnected(s) ? 1 : ctx.offRoad;
    let c = d.income * ctx.mult * link;
    if (d.customers) c *= ctx.commerce;
    c += (d.incomePerSec * this.tickMs) / 1000; // flat per-second earners
    return { coins: Math.round(c), materials: Math.round(d.materialsPerTick * link * ctx.wood) };
  }

  /**
   * Coins & materials produced in one tick at the current state.
   * @param {Array} [payouts] optional array filled with per-structure results
   */
  computeYield(payouts) {
    const ctx = this.yieldContext();
    let coins = 0;
    let materials = 0;
    for (const s of this.structures) {
      if (!s.def.income && !s.def.incomePerSec && !s.def.materialsPerTick) continue;
      const y = this.structureYield(s, ctx);
      coins += y.coins;
      materials += y.materials;
      if (payouts && (y.coins || y.materials)) payouts.push({ s, coins: y.coins, materials: y.materials });
    }
    return { coins, materials };
  }

  /** Called every tick (state.tickMs). Returns a report for visuals. */
  tick() {
    this.ticks++;
    this.happiness = this.computeHappiness();

    // Population drifts toward housing capacity while villagers are content.
    const cap = this.capacity;
    if (this.population < cap && this.happiness >= CONFIG.GROWTH_MIN_HAPPINESS) {
      this.population += Math.max(1, Math.ceil((cap - this.population) / 2));
    } else if (this.population > 0 && this.happiness < 20) {
      this.population--; // unhappy villagers leave
    }
    this.population = Math.min(this.population, cap);

    const payouts = [];
    const y = this.computeYield(payouts);
    this.coins += y.coins;
    this.materials += y.materials;

    this.recalculate();
    return { coins: y.coins, materials: y.materials, payouts };
  }

  /** Refresh derived values and notify listeners (HUD). */
  recalculate() {
    this.happiness = this.computeHappiness();
    this.projection = this.computeYield();
    this.bus.emit('stats', this.stats());
  }

  stats() {
    return {
      coins: this.coins,
      materials: this.materials,
      population: this.population,
      capacity: this.capacity,
      happiness: this.happiness,
      income: this.projection.coins,
      matIncome: this.projection.materials,
      ticks: this.ticks,
      tickLevel: this.tickLevel + 1,
      tickMs: this.tickMs,
      tickCost: this.nextTickCost,
      towerLevel: 1 + this.upgradeLevel('towers'),
      towerCost: this.nextUpgradeCost('towers'),
      tiers: this.techStatus(),
      upgrades: this.upgradeStatus(),
      biome: this.activeBiome,
      biomes: this.biomeStatus(),
    };
  }
}

/* ==========================================================================
 * 5. UIController — DOM HUD. Caches values so it only touches the DOM when
 *    something actually changed (keeps layout/paint out of the frame budget).
 * ======================================================================== */
class UIController {
  constructor(bus) {
    this.bus = bus;
    this.cache = Object.create(null);
    this.buttons = new Map();
    this.toastTimer = 0;

    this.el = {
      toolbar: document.getElementById('toolbar'),
      info: document.getElementById('info-panel'),
      toast: document.getElementById('toast'),
      tickFill: document.getElementById('tick-fill'),
      happyFill: document.getElementById('happy-fill'),
      happyStat: document.getElementById('stat-happiness'),
      coinStat: document.getElementById('stat-coins'),
      tickUpgrade: document.getElementById('tick-upgrade'),
      towerUpgrade: document.getElementById('tower-upgrade'),
      techOpen: document.getElementById('open-tech'),
      techOverlay: document.getElementById('tech-overlay'),
      techClose: document.getElementById('tech-close'),
      techList: document.getElementById('tech-list'),
      upgOpen: document.getElementById('open-upgrades'),
      upgOverlay: document.getElementById('upgrade-overlay'),
      upgClose: document.getElementById('upgrade-close'),
      upgList: document.getElementById('upgrade-list'),
      biomeTabs: document.getElementById('biome-tabs'),
      biomeOverlay: document.getElementById('biome-overlay'),
      biomeClose: document.getElementById('biome-close'),
      biomeList: document.getElementById('biome-list'),
      buildTitle: document.getElementById('build-title'),
      raid: document.getElementById('raid-status'),
      raidCall: document.getElementById('raid-call'),
      raidAuto: document.getElementById('raid-auto'),
      hallFill: document.getElementById('hall-fill'),
      gameOver: document.getElementById('gameover-overlay'),
      gameOverText: document.getElementById('gameover-text'),
      stats: {},
    };
    document.querySelectorAll('[data-stat]').forEach((n) => { this.el.stats[n.dataset.stat] = n; });

    this.lockedTools = new Set(TOOLS.filter((t) => TIER_OF_TOOL[t.id]).map((t) => t.id));

    this.buildToolbar();
    this.setupTechTree();
    this.setupUpgrades();
    this.setupBiomes();
    this.el.tickUpgrade.addEventListener('click', () => this.bus.emit('upgrade:tick'));
    this.el.towerUpgrade.addEventListener('click', () => this.bus.emit('upgrade:buy', 'towers'));
    this.el.raidCall.addEventListener('click', () => this.bus.emit('raid:call'));
    this.el.raidAuto.addEventListener('click', () => this.bus.emit('raid:mode:toggle'));
    document.getElementById('save-btn').addEventListener('click', () => this.bus.emit('save'));
    document.getElementById('newgame-btn').addEventListener('click', () => this.bus.emit('newgame'));
    document.getElementById('clear-btn').addEventListener('click', () => {
      const pct = CONFIG.REFUND_RATE * 100;
      const name = BIOME_BY_ID[this.cache.biome || 'meadow'].name;
      if (window.confirm(`Clear the ${name}? Every building and road in this biome is removed and refunded ${pct}% of its coins. Other biomes, coins, upgrades and tech are kept.`)) {
        this.bus.emit('grid:clear');
      }
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); // don't open the browser's "Save page" dialog
        this.bus.emit('save');
      }
    });

    bus.on('stats', this.renderStats, this);
    bus.on('tool:select', this.onToolSelected, this);
    bus.on('tower:info', this.renderTowerInfo, this);
    bus.on('toast', this.toast, this);
    bus.on('tick', this.onTick, this);
    bus.on('ready', this.onReady, this);
    bus.on('raid:status', this.renderRaid, this);
    bus.on('raid:warning', this.onRaidWarning, this);
    bus.on('raid:start', this.onRaidStart, this);
    bus.on('raid:hit', this.onRaidHit, this);
    bus.on('raid:won', this.onRaidWon, this);
    bus.on('raid:mode', this.onRaidMode, this);
    bus.on('gameover', this.showGameOver, this);
    document.getElementById('gameover-restart').addEventListener('click', () => window.location.reload());
  }

  /* ---------- Raids ---------- */
  /** "the Meadow" when you're elsewhere, so toasts say where the trouble is. */
  where(biome) {
    return biome === this.cache.biome ? 'your village' : `the ${BIOME_BY_ID[biome].name}`;
  }

  onRaidWarning({ biome, enemy, secs, called }) {
    const tower = TOWER_OF_BIOME[biome];
    if (called) {
      this.toast(`\u2694\uFE0F You called in the ${enemy.plural}! They arrive in ${secs}s.`, 'warn', 3500);
      return;
    }
    this.toast(`\u2694\uFE0F ${enemy.plural} will raid ${this.where(biome)} in ${secs}s! Build ${tower.name}s [F]`, 'warn', 4000);
  }

  onRaidStart({ biome, enemy, count }) {
    this.toast(`\u2694\uFE0F RAID! ${count} ${enemy.plural} are attacking ${this.where(biome)}!`, 'error', 3500);
    if (enemy.trait) this.toast(`\u{1F9EC} ${enemy.trait}: ${enemy.desc}`, 'warn', 4500);
  }

  onRaidHit({ biome, hp }) {
    this.toast(`\u{1F6A8} ${BIOME_BY_ID[biome].name} Town Hall hit! ${hp}/${CONFIG.HALL_HP} HP`, 'error', 2200);
  }

  onRaidWon({ biome, enemy, next, reward, bonus, leaked }) {
    const name = BIOME_BY_ID[biome].name;
    if (!reward) {
      this.toast(`The ${name} survived, but ${leaked} ${leaked === 1 ? enemy.name : enemy.plural} got through. No reward — build more towers!`, 'warn', 4000);
    } else {
      const extra = bonus ? ` (incl. +${fmt(bonus)} early-call bonus)` : '';
      this.toast(`\u{1F3C6} ${enemy.plural} defeated in the ${name}! +${fmt(reward)} coins${extra}`, 'good', 4000);
    }
    // Survive one and the raiders come back as something else.
    if (next && next.trait) {
      this.toast(`\u{1F9EC} They adapt! Next wave: ${next.plural} — ${next.desc}`, 'warn', 5000);
    }
  }

  onRaidMode({ mode }) {
    this.toast(
      mode === 'manual'
        ? '\u23F8\uFE0F Timed raids off — raids only come when you Call them [R].'
        : '\u23F1\uFE0F Timed raids back on — the countdown is running again.',
      'info', 3500,
    );
  }

  renderRaid(r) {
    const paused = r.mode === 'manual' && !r.active;
    const label = r.active ? `RAID: ${r.enemy.plural}` : paused ? 'Raids on call' : 'Next raid';
    const mins = Math.floor(r.secs / 60);
    const value = r.active
      ? `\u2694\uFE0F ${r.left} left`
      : paused ? 'Ready [R]' : `${mins}:${String(r.secs % 60).padStart(2, '0')}`;
    this.setText('raidLabel', label);
    this.setText('raidValue', value);
    this.setText('raidEnemy', r.active
      ? `Wave ${r.wave + 1}: ${r.enemy.desc}`
      : `Next: ${r.enemy.plural} (wave ${r.wave + 1})`);
    this.setText('raidElsewhere', r.elsewhere.length ? `\u26A0\uFE0F ${r.elsewhere.join(', ')} under attack!` : '');

    if (this.cache.raidCanCall !== r.canCall) {
      this.cache.raidCanCall = r.canCall;
      this.el.raidCall.disabled = !r.canCall;
    }
    const callText = r.active ? '\u2694\uFE0F In progress' : r.bonus ? `\u2694\uFE0F Call +${short(r.bonus)}` : '\u2694\uFE0F Call [R]';
    if (this.cache.raidCallText !== callText) {
      this.cache.raidCallText = callText;
      this.el.raidCall.textContent = callText;
      this.el.raidCall.title = r.active
        ? 'A raid is already under way.'
        : `Start the ${r.enemy.plural} raid now [R] — ${r.enemy.desc}. Early-call bonus: +${fmt(r.bonus)} coins.`;
    }
    if (this.cache.raidMode !== r.mode) {
      this.cache.raidMode = r.mode;
      const auto = r.mode === 'auto';
      this.el.raidAuto.textContent = `Auto: ${auto ? 'ON' : 'OFF'}`;
      this.el.raidAuto.setAttribute('aria-pressed', String(auto));
    }

    const state = r.active
      ? 'active'
      : paused ? 'paused'
        : r.secs * 1000 <= CONFIG.RAID_WARN_MS ? 'soon'
          : r.elsewhere.length ? 'elsewhere' : 'calm';
    if (this.cache.raidState !== state) {
      this.cache.raidState = state;
      this.el.raid.dataset.state = state;
    }
    if (this.cache.hallHp !== r.hallHp) {
      this.cache.hallHp = r.hallHp;
      this.el.hallFill.style.width = `${(r.hallHp / CONFIG.HALL_HP) * 100}%`;
      this.el.raid.title = `Town Hall: ${r.hallHp}/${CONFIG.HALL_HP} HP. Build defense towers [F] to stop raids.`;
    }
  }

  showGameOver({ biome, enemy, raidsWon }) {
    this.closeTechTree();
    this.closeUpgrades();
    this.closeBiomes();
    const b = BIOME_BY_ID[biome];
    this.el.gameOverText.textContent = `${enemy.plural} destroyed your Town Hall in the ${b.icon} ${b.name}. `
      + `You defeated ${raidsWon} raid${raidsWon === 1 ? '' : 's'} before the village fell.`;
    this.el.gameOver.hidden = false;
    document.getElementById('gameover-restart').focus();
  }

  buildToolbar() {
    const frag = document.createDocumentFragment();
    TOOLS.forEach((tool, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool';
      btn.dataset.tool = tool.id;
      btn.title = `${tool.name} [${toolKey(i)}]`;
      btn.innerHTML = `
        <span class="tool-key">${toolKey(i)}</span>
        <span class="tool-art"><img alt="" data-icon="ui_${tool.art}" /><span class="tool-lock">\u{1F512}</span></span>
        <span class="tool-name">${tool.name}</span>
        <span class="tool-cost">${this.costHTML(tool)}</span>
        ${tool.income ? `<span class="tool-yield">+${tool.income}/t</span>` : ''}
        ${tool.incomePerSec ? `<span class="tool-yield">+${short(tool.incomePerSec)}/s</span>` : ''}
        ${tool.tower ? `<span class="tool-yield tool-def">${Math.round((tool.tower.damage * 1000) / tool.tower.rate)} dps</span>` : ''}`;
      frag.appendChild(btn);
      this.buttons.set(tool.id, btn);
    });
    this.el.toolbar.appendChild(frag);

    // One delegated listener instead of one per button.
    this.el.toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.tool');
      if (!btn) return;
      const id = btn.dataset.tool;
      if (this.lockedTools.has(id) && !this.unlockedToolSet?.has(id)) {
        this.bus.emit('toast', `${TOOL_BY_ID[id].name} is locked — check the Tech Tree`, 'warn');
        this.openTechTree(TIER_OF_TOOL[id]?.id);
        return;
      }
      // Clicking the active tool again drops back to Inspect.
      this.bus.emit('tool:select', id === this.activeTool && id !== 'pan' ? 'pan' : id);
    });
  }

  /* ---------- Tech Tree modal ---------- */
  setupTechTree() {
    this.el.techOpen.addEventListener('click', () => this.openTechTree());
    this.el.techClose.addEventListener('click', () => this.closeTechTree());
    this.el.techOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.techOverlay) this.closeTechTree();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeTechTree();
    });
    this.el.techList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-unlock]');
      if (btn) this.bus.emit('tech:unlock', btn.dataset.unlock);
    });
  }

  openTechTree(highlightTierId) {
    this.closeUpgrades();
    this.closeBiomes();
    this.el.techOverlay.hidden = false;
    if (highlightTierId) {
      const card = this.el.techList.querySelector(`[data-tier="${highlightTierId}"]`);
      card?.scrollIntoView({ block: 'nearest' });
      card?.classList.add('flash');
      setTimeout(() => card?.classList.remove('flash'), 900);
    }
  }

  closeTechTree() { this.el.techOverlay.hidden = true; }

  /* ---------- Upgrades modal ---------- */
  setupUpgrades() {
    this.el.upgOpen.addEventListener('click', () => this.openUpgrades());
    this.el.upgClose.addEventListener('click', () => this.closeUpgrades());
    this.el.upgOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.upgOverlay) this.closeUpgrades();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeUpgrades();
      else if (e.key.toLowerCase() === 'u' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (this.el.upgOverlay.hidden) this.openUpgrades();
        else this.closeUpgrades();
      }
    });
    this.el.upgList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-buy]');
      if (btn) this.bus.emit('upgrade:buy', btn.dataset.buy);
    });
  }

  openUpgrades() {
    this.closeTechTree();
    this.closeBiomes();
    this.el.upgOverlay.hidden = false;
  }

  closeUpgrades() { this.el.upgOverlay.hidden = true; }

  /* ---------- Biomes: map tabs + modal ---------- */
  setupBiomes() {
    const onClick = (e) => {
      const travel = e.target.closest('[data-travel]');
      if (travel) {
        this.bus.emit('biome:travel', travel.dataset.travel);
        return;
      }
      const buy = e.target.closest('[data-buy-biome]');
      if (buy) {
        this.bus.emit('biome:unlock', buy.dataset.buyBiome);
        return;
      }
      const open = e.target.closest('[data-open-biomes]');
      if (open) this.openBiomes(open.dataset.openBiomes);
    };
    this.el.biomeTabs.addEventListener('click', onClick);
    this.el.biomeList.addEventListener('click', onClick);
    this.el.biomeClose.addEventListener('click', () => this.closeBiomes());
    this.el.biomeOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.biomeOverlay) this.closeBiomes();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeBiomes();
      else if (e.key.toLowerCase() === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (this.el.biomeOverlay.hidden) this.openBiomes();
        else this.closeBiomes();
      }
    });
    this.bus.on('biome:entered', () => this.closeBiomes());
  }

  openBiomes(highlightId) {
    this.closeTechTree();
    this.closeUpgrades();
    this.el.biomeOverlay.hidden = false;
    if (highlightId) {
      const card = this.el.biomeList.querySelector(`[data-biome="${highlightId}"]`);
      card?.scrollIntoView({ block: 'nearest' });
      card?.classList.add('flash');
      setTimeout(() => card?.classList.remove('flash'), 900);
    }
  }

  closeBiomes() { this.el.biomeOverlay.hidden = true; }

  /** Show only the current biome's tools, renumbering the 1-0 hotkeys to match. */
  applyBiomeToolbar(biomeId) {
    const list = TOOLS_BY_BIOME[biomeId] || TOOLS;
    const visible = new Set(list.map((t) => t.id));
    for (const [id, btn] of this.buttons) btn.hidden = !visible.has(id);
    list.forEach((t, i) => {
      const btn = this.buttons.get(t.id);
      const key = toolKey(i);
      btn.querySelector('.tool-key').textContent = key;
      btn.title = key ? `${t.name} [${key}]` : t.name;
    });
    const b = BIOME_BY_ID[biomeId];
    if (b && this.el.buildTitle) this.el.buildTitle.textContent = `Build: ${b.icon} ${b.name}`;
  }

  renderBiomes(biomes) {
    const key = biomes.map((b) => `${b.id}:${b.unlocked}:${b.available}:${b.affordable}:${b.active}:${b.raiding}`).join('|');
    if (this.cache.biomesKey === key) return;
    this.cache.biomesKey = key;

    // Tabs: every unlocked biome, plus the next one to buy.
    const tabs = biomes.filter((b) => b.unlocked || b.available).map((b) => (b.unlocked
      ? `<button type="button" class="biome-tab${b.active ? ' active' : ''}${b.raiding ? ' raiding' : ''}" data-travel="${b.id}"
           title="Travel to the ${b.name} (${b.size}x${b.size})${b.raiding ? ' — UNDER ATTACK!' : ''}">${b.raiding ? '\u2694\uFE0F ' : ''}${b.icon} ${b.name}</button>`
      : `<button type="button" class="biome-tab locked${b.affordable ? ' ready' : ''}" data-open-biomes="${b.id}"
           title="Unlock the ${b.name}">\u{1F512} ${b.icon} ${b.name} <span class="c-coins">${short(b.cost)}</span></button>`));
    tabs.push('<button type="button" class="biome-tab" data-open-biomes="" title="All biomes [B]">\u{1F30D} Biomes</button>');
    this.el.biomeTabs.innerHTML = tabs.join('');

    this.el.biomeList.innerHTML = biomes.map((b, i) => {
      const state = b.unlocked ? 'unlocked' : b.available ? 'available' : 'locked';
      const buildingHTML = TOOLS.filter((t) => t.biome === b.id).map((t) =>
        `<li><img alt="" data-icon="ui_${t.art}" /><span>${t.name}</span></li>`).join('');
      let action;
      if (b.active) action = '<span class="tier-status">\u2713 You are here</span>';
      else if (b.unlocked) action = `<button type="button" class="tier-unlock" data-travel="${b.id}">Travel</button>`;
      else if (b.available) {
        action = `<button type="button" class="tier-unlock${b.affordable ? '' : ' unaffordable'}" data-buy-biome="${b.id}">
            Unlock <span class="c-coins">${fmt(b.cost)}</span></button>`;
      } else {
        action = `<button type="button" class="tier-unlock" disabled>Unlock the ${biomes[i - 1].name} first</button>`;
      }
      return `
        <div class="tier-card biome-card" data-biome="${b.id}" data-state="${state}">
          <h3><span class="upg-icon">${b.icon}</span>${b.name} <span class="upg-lvl">${b.size}x${b.size}</span></h3>
          <p class="upg-desc">${BIOME_BY_ID[b.id].desc}</p>
          <p class="upg-desc">\u2694\uFE0F Raiders: ${b.unlocked ? `${b.raider} (wave ${b.wave + 1})` : ENEMIES[b.id].plural} &middot; Defense: ${TOWER_OF_BIOME[b.id].name}</p>
          <ul class="tier-buildings">${buildingHTML}</ul>
          ${action}
        </div>`;
    }).join('');
    this.stampIcons(this.el.biomeList);
  }

  /** Point freshly injected <img data-icon> tags at the generated pixel-art textures. */
  stampIcons(root) {
    if (!this.textures) return;
    root.querySelectorAll('img[data-icon]').forEach((img) => {
      const k = img.dataset.icon;
      if (this.textures.exists(k)) img.src = this.textures.getBase64(k);
    });
  }

  renderUpgrades(list) {
    const ready = list.filter((u) => u.affordable).length;
    this.setText('upgradesReady', ready ? `${ready} ready` : 'View');
    this.el.upgOpen.classList.toggle('ready', ready > 0);

    const key = list.map((u) => `${u.id}:${u.level}:${u.affordable}`).join('|');
    if (this.cache.upgradesKey === key) return;
    this.cache.upgradesKey = key;

    this.el.upgList.innerHTML = list.map((u) => {
      const maxed = u.cost === null;
      const state = maxed ? 'unlocked' : u.affordable ? 'available' : 'pricey';
      const pips = Array.from({ length: u.max }, (_v, i) => `<i class="${i < u.level ? 'on' : ''}"></i>`).join('');
      const action = maxed
        ? `<span class="tier-status">\u2713 Maxed</span>`
        : `<button type="button" class="tier-unlock${u.affordable ? '' : ' unaffordable'}" data-buy="${u.id}">
             Buy Lv ${u.level + 1} <span class="c-coins">${fmt(u.cost)}</span>
           </button>`;
      return `
        <div class="tier-card upg-card" data-upgrade="${u.id}" data-state="${state}">
          <h3><span class="upg-icon">${u.icon}</span>${u.name} <span class="upg-lvl">Lv ${u.level}/${u.max}</span></h3>
          <p class="upg-desc">${u.desc}</p>
          <div class="upg-pips">${pips}</div>
          <p class="upg-effect">Now: ${u.now}</p>
          ${maxed ? '' : `<p class="upg-effect next">Next: ${u.next}</p>`}
          ${action}
        </div>`;
    }).join('');
  }

  renderTechTree(tiers) {
    const key = tiers.map((t) => `${t.id}:${t.unlocked}:${t.affordable}:${t.available}`).join('|');
    if (this.cache.tiersKey === key) return;
    this.cache.tiersKey = key;

    this.el.techList.innerHTML = tiers.map((t) => {
      const state = t.unlocked ? 'unlocked' : t.available ? 'available' : 'locked';
      const buildingHTML = t.buildings.map((id) => {
        const tool = TOOL_BY_ID[id];
        return `<li><img alt="" data-icon="ui_${tool.art}" /><span>${tool.name}</span></li>`;
      }).join('');
      const action = t.unlocked
        ? `<span class="tier-status">\u2713 Unlocked</span>`
        : `<button type="button" class="tier-unlock" data-unlock="${t.id}" ${t.available ? '' : 'disabled'}>
             Unlock <span class="c-coins">${fmt(t.cost)}</span>
           </button>`;
      return `
        <div class="tier-card" data-tier="${t.id}" data-state="${state}">
          <h3>${t.name}</h3>
          <ul class="tier-buildings">${buildingHTML}</ul>
          ${action}
        </div>`;
    }).join('');

    // Re-stamp icon sources on the newly injected <img> tags.
    this.el.techList.querySelectorAll('img[data-icon]').forEach((img) => {
      const key2 = img.dataset.icon;
      if (this.textures && this.textures.exists(key2)) img.src = this.textures.getBase64(key2);
    });
  }

  costHTML(tool) {
    if (tool.kind === 'pan') return 'Esc';
    if (tool.kind === 'bulldoze') return `${CONFIG.REFUND_RATE * 100}% back`;
    const { coins, materials } = tool.cost;
    return `<span class="c-coins">${short(coins)}</span>${materials ? `<span class="c-mats">${materials}</span>` : ''}`;
  }

  /** Scene finished generating textures: reuse them as crisp DOM icons. */
  onReady(textures) {
    this.textures = textures;
    document.querySelectorAll('img[data-icon]').forEach((img) => {
      const key = img.dataset.icon;
      if (textures.exists(key)) img.src = textures.getBase64(key);
    });
    this.restartTickBar();
  }

  onToolSelected(id) {
    this.activeTool = id;
    for (const [toolId, btn] of this.buttons) {
      const active = toolId === id;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    this.cache.towerKey = null;
    this.renderInfo(TOOL_BY_ID[id]);
  }

  /** Side panel for an inspected defense tower: stats, next-level preview, upgrade button. */
  renderTowerInfo(info) {
    if (!info) {
      if (this.cache.towerKey) {
        this.cache.towerKey = null;
        this.renderInfo(TOOL_BY_ID[this.activeTool] || TOOL_BY_ID.pan);
      }
      return;
    }
    // Only rebuild the DOM when something visible changed (keeps the button clickable).
    const key = `${info.uid}:${info.level}:${info.affordable}`;
    if (this.cache.towerKey === key) return;
    this.cache.towerKey = key;

    const { stats: t, next: n, cost } = info;
    const up = (now, later, fmtV = (v) => v) =>
      (n && later !== now ? ` <span class="upg-next">&rarr; ${fmtV(later)}</span>` : '');
    const perSec = (rate) => (1000 / rate).toFixed(1);
    const pips = Array.from({ length: info.max }, (_v, i) => `<i class="${i < info.level ? 'on' : ''}"></i>`).join('');
    const fx = [
      `<li class="pos">${t.damage} damage${up(t.damage, n?.damage)}</li>`,
      `<li class="pos">${perSec(t.rate)} shots/s${up(perSec(t.rate), n && perSec(n.rate))}</li>`,
      `<li class="pos">range ${t.range} tiles${up(t.range, n?.range)}</li>`,
    ];
    if (t.slow) fx.push(`<li class="pos">slows by ${Math.round((1 - t.slow) * 100)}%</li>`);
    if (t.splash) fx.push(`<li class="pos">splash ${t.splash} tiles</li>`);
    fx.push(`<li>stops ${info.enemy}</li>`);

    const action = cost
      ? `<button type="button" class="tier-unlock tower-upgrade${info.affordable ? '' : ' unaffordable'}" data-tower-upgrade>
           Upgrade ${info.shared ? 'all ' : ''}to Lv ${info.level + 1}
           <span class="c-coins">${short(cost.coins)}</span>${cost.materials ? `<span class="c-mats">${cost.materials}</span>` : ''}
         </button>`
      : `<p class="tier-status tower-upgrade">\u2713 Max level</p>`;

    this.el.info.innerHTML = `
      <h3 class="tower-title">${info.name} <span class="upg-lvl">Lv ${info.level}/${info.max}</span></h3>
      <div class="upg-pips">${pips}</div>
      <ul class="effects">${fx.join('')}</ul>
      ${info.shared ? '<p>Upgrades every defense tower in every biome. Also in the top bar &amp; Upgrades panel.</p>' : ''}
      ${action}`;

    this.el.info.querySelector('[data-tower-upgrade]')?.addEventListener('click', () => {
      this.bus.emit('tower:upgrade');
    });
  }

  renderInfo(tool) {
    const fx = [];
    const add = (v, label) => v && fx.push(`<li class="${v > 0 ? 'pos' : 'neg'}">${v > 0 ? '+' : ''}${v} ${label}</li>`);
    add(tool.residents, 'residents');
    add(tool.income, 'coins/tick');
    if (tool.incomePerSec) fx.push(`<li class="pos">+${short(tool.incomePerSec)} coins/sec</li>`);
    add(tool.materialsPerTick, 'wood/tick');
    add(tool.happiness, 'happiness');
    if (tool.power) fx.push(`<li class="pos">+${tool.power * 100}% all income</li>`);
    if (tool.customers) fx.push(`<li>needs ${tool.customers} customers</li>`);
    const tw = tool.tower;
    if (tw) {
      fx.push(`<li class="pos">${tw.damage} damage, ${(1000 / tw.rate).toFixed(1)} shots/s</li>`);
      fx.push(`<li class="pos">range ${tw.range} tiles</li>`);
      if (tw.slow) fx.push(`<li class="pos">slows by ${Math.round((1 - tw.slow) * 100)}%</li>`);
      if (tw.splash) fx.push(`<li class="pos">splash ${tw.splash} tiles</li>`);
      fx.push(`<li>stops ${ENEMIES[tool.biome].plural}</li>`);
    }
    if (tool.w > 1 || tool.h > 1) fx.push(`<li>size ${tool.w}x${tool.h}</li>`);
    if (tool.paint && tool.kind !== 'pan') fx.push(`<li>hold & drag to ${tool.kind === 'bulldoze' ? 'clear' : 'place'} many</li>`);

    const tier = TIER_OF_TOOL[tool.id];
    const locked = tier && !this.unlockedToolSet?.has(tool.id);
    const lockHTML = locked
      ? `<p class="lock-note">\u{1F512} Locked — unlock <strong>${tier.name}</strong> in the
           <button type="button" class="link-btn" data-unlock="${tier.id}">Tech Tree</button> (${fmt(tier.cost)} coins)</p>`
      : '';

    this.el.info.innerHTML = `
      <h3>${tool.name}</h3>
      ${tool.kind === 'build' ? `<p class="tool-cost">${this.costHTML(tool)}</p>` : ''}
      <p>${tool.desc}</p>
      ${fx.length ? `<ul class="effects">${fx.join('')}</ul>` : ''}
      ${lockHTML}`;

    this.el.info.querySelector('[data-unlock]')?.addEventListener('click', (e) => {
      this.bus.emit('tech:unlock', e.currentTarget.dataset.unlock);
    });
  }

  setText(key, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    const el = this.el.stats[key];
    if (el) el.textContent = value;
  }

  renderStats(s) {
    this.setText('coins', short(s.coins));
    this.setText('income', `+${short(s.income)}/t`);
    this.setText('population', `${s.population}/${s.capacity}`);
    this.setText('happiness', `${s.happiness}%`);
    this.setText('materials', fmt(s.materials));
    this.setText('matIncome', `+${s.matIncome}/t`);

    if (this.cache.happyPct !== s.happiness) {
      this.cache.happyPct = s.happiness;
      this.el.happyFill.style.width = `${s.happiness}%`;
      this.el.happyStat.dataset.mood = s.happiness >= 65 ? 'good' : s.happiness < 35 ? 'bad' : 'ok';
    }

    this.unlockedToolSet = new Set(
      s.tiers.filter((t) => t.unlocked).flatMap((t) => t.buildings).concat([...ALWAYS_UNLOCKED]),
    );
    for (const [id, btn] of this.buttons) {
      const t = TOOL_BY_ID[id];
      const locked = this.lockedTools.has(id) && !this.unlockedToolSet.has(id);
      btn.classList.toggle('locked', locked);
      if (t.kind !== 'build') continue;
      btn.classList.toggle('unaffordable', !locked && (s.coins < t.cost.coins || s.materials < t.cost.materials));
    }

    this.renderTechTree(s.tiers);
    this.renderUpgrades(s.upgrades);
    if (this.cache.biome !== s.biome) {
      this.cache.biome = s.biome;
      this.applyBiomeToolbar(s.biome);
    }
    this.renderBiomes(s.biomes);

    // Tick-speed upgrade
    this.setText('tickSecs', `${(s.tickMs / 1000).toFixed(1)}s`);
    this.setText('tickLevel', String(s.tickLevel));
    this.setText('tickCost', s.tickCost === null ? 'MAX' : fmt(s.tickCost));
    const maxed = s.tickCost === null;
    this.el.tickUpgrade.disabled = maxed;
    this.el.tickUpgrade.classList.toggle('unaffordable', !maxed && s.coins < s.tickCost);

    // Archer tower upgrade (top bar)
    this.setText('towerLevel', String(s.towerLevel));
    this.setText('towerCost', s.towerCost === null ? 'MAX' : fmt(s.towerCost));
    const towersMaxed = s.towerCost === null;
    this.el.towerUpgrade.disabled = towersMaxed;
    this.el.towerUpgrade.classList.toggle('unaffordable', !towersMaxed && s.coins < s.towerCost);
    if (this.cache.tickMs !== s.tickMs) {
      this.cache.tickMs = s.tickMs;
      document.documentElement.style.setProperty('--tick-ms', `${s.tickMs}ms`);
      this.restartTickBar();
    }
  }

  onTick(report) {
    this.restartTickBar();
    if (report.coins > 0) this.retrigger(this.el.coinStat, 'bump');
  }

  restartTickBar() { this.retrigger(this.el.tickFill, 'run'); }

  /** Restart a CSS animation by removing/re-adding its class. */
  retrigger(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add(cls);
  }

  toast(message, kind = 'info', duration = 1800) {
    const el = this.el.toast;
    el.textContent = message;
    el.dataset.kind = kind;
    this.retrigger(el, 'show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  }
}

/* ==========================================================================
 * 6. VillageScene — rendering, camera, input & placement
 * ======================================================================== */
class VillageScene extends Phaser.Scene {
  constructor() {
    super('Village');
  }

  init(data) {
    this.bus = data.bus;
    this.state = data.state;

    this.tool = TOOL_BY_ID.pan;
    this.zoomIndex = CONFIG.START_ZOOM_INDEX;
    this.gridEnabled = true;

    // Pointer / hover state (reused objects: no per-frame allocations)
    this.hoverX = -1;
    this.hoverY = -1;
    this.pointerInside = false;
    this.isPanning = false;
    this.isPainting = false;
    this.strokeWarned = false;
    this.dragDistance = 0;
    this.lastPaintX = -1;
    this.lastPaintY = -1;
    this.lastWheelAt = 0;
    this.lastPan = new Phaser.Math.Vector2();
    this.tmpVec = new Phaser.Math.Vector2();
  }

  create() {
    this.generateTextures();
    this.createWorld();
    this.createCursor();
    this.createRaidLayer();
    this.createFloatPool();
    this.walkers = [];
    this.walkerSpawnT = 0;
    this.walkerOpts = [];
    this.renderBiomeStructures();
    this.setupCamera();
    this.setupInput();
    this.setupEconomy();

    this.bus.on('tool:select', this.setTool, this);
    this.bus.on('upgrade:tick', this.upgradeTickSpeed, this);
    this.bus.on('upgrade:buy', this.buyUpgrade, this);
    this.bus.on('tech:unlock', this.unlockTier, this);
    this.bus.on('grid:clear', this.clearGrid, this);
    this.bus.on('biome:unlock', this.unlockBiome, this);
    this.bus.on('biome:travel', this.travelTo, this);
    this.bus.on('stats', this.refreshCursor, this); // affordability may change ghost tint
    this.bus.on('stats', this.emitTowerInfo, this); // keep the inspected tower's panel current
    this.bus.on('tower:upgrade', this.upgradeSelectedTower, this);
    this.bus.on('raid:call', this.callRaid, this);
    this.bus.on('raid:mode:toggle', this.toggleRaidMode, this);
    this.bus.on('enemy:removed', this.onEnemyRemoved, this);
    this.bus.on('tower:shot', this.onTowerShot, this);
    this.bus.on('raid:hit', this.onRaidHit, this);
    this.bus.on('raid:won', this.onRaidWon, this);
    this.bus.on('gameover', this.onGameOver, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.bus.off('enemy:removed', this.onEnemyRemoved, this);
      this.bus.off('tower:shot', this.onTowerShot, this);
      this.bus.off('raid:hit', this.onRaidHit, this);
      this.bus.off('raid:won', this.onRaidWon, this);
      this.bus.off('gameover', this.onGameOver, this);
      this.bus.off('tool:select', this.setTool, this);
      this.bus.off('upgrade:tick', this.upgradeTickSpeed, this);
      this.bus.off('upgrade:buy', this.buyUpgrade, this);
      this.bus.off('tech:unlock', this.unlockTier, this);
      this.bus.off('grid:clear', this.clearGrid, this);
      this.bus.off('biome:unlock', this.unlockBiome, this);
      this.bus.off('biome:travel', this.travelTo, this);
      this.bus.off('stats', this.refreshCursor, this);
      this.bus.off('stats', this.emitTowerInfo, this);
      this.bus.off('tower:upgrade', this.upgradeSelectedTower, this);
      this.bus.off('raid:call', this.callRaid, this);
      this.bus.off('raid:mode:toggle', this.toggleRaidMode, this);
    });

    this.bus.emit('ready', this.textures);
    this.bus.emit('tool:select', 'pan');
    this.state.recalculate();
  }

  /* ---------- Textures (procedural pixel art) ---------- */
  generateTextures() {
    const gen = (key, rows, scale = CONFIG.ART_SCALE) => {
      if (!this.textures.exists(key)) {
        this.textures.generate(key, { data: normalizeArt(rows), pixelWidth: scale });
      }
    };

    // World sprites
    TOOLS.forEach((t) => { if (t.texture && !t.isRoad) gen(t.texture, ART[t.art]); });
    gen('tile_road', ART.road);
    gen(TOWN_HALL.texture, ART.townhall);

    // Raiders: enemy_<biome>_<frame>
    this.enemyKeys = Object.fromEntries(BIOMES.map((b) => [b.id, ENEMY_ART[b.id].map((rows, f) => {
      const key = `enemy_${b.id}_${f}`;
      gen(key, rows);
      return key;
    })]));

    // UI icons (larger scale, exported to the DOM as data URLs)
    TOOLS.forEach((t) => gen(`ui_${t.art}`, ART[t.art], t.uiScale));
    ['icon_coin', 'icon_pop', 'icon_happy', 'icon_mat'].forEach((k) => gen(k, ART[k], CONFIG.UI_ART_SCALE));

    // Villager walk frames: walker_<look>_<frame>
    this.walkerKeys = WALKER_LOOKS.map((look, i) => WALKER_FRAMES.map((frame, f) => {
      const key = `walker_${i}_${f}`;
      gen(key, recolorArt(frame, look));
      return key;
    }));

    // One tileset strip per biome, order must match TILE_INDEX
    for (const b of BIOMES) {
      gen(`tileset_${b.id}`, buildExtrudedStrip([...b.ground.map((k) => ART[k]), ART.road].map(normalizeArt)));
    }

    const T = CONFIG.TILE;
    const g = this.make.graphics({ x: 0, y: 0 }, false);

    // Hover cursor (white so it can be tinted green/red)
    g.lineStyle(2, 0xffffff, 1).strokeRect(1, 1, T - 2, T - 2);
    g.fillStyle(0xffffff, 0.15).fillRect(2, 2, T - 4, T - 4);
    g.generateTexture('cursor', T, T);

    // Grid cell: 2px lines on top/left edges, repeated by a TileSprite
    g.clear().fillStyle(0x000000, 0.12).fillRect(0, 0, T, 2).fillRect(0, 0, 2, T);
    g.generateTexture('gridcell', T, T);

    // Tower projectile (white core so it can be tinted per tower)
    g.clear().fillStyle(0x000000, 1).fillRect(0, 0, 8, 8).fillStyle(0xffffff, 1).fillRect(2, 2, 4, 4);
    g.generateTexture('shot', 8, 8);
    g.destroy();
  }

  /* ---------- World (rebuilt whenever you travel to another biome) ---------- */
  createWorld() {
    const T = CONFIG.TILE;
    const S = CONFIG.ART_SCALE;
    const biome = BIOME_BY_ID[this.state.activeBiome];
    const n = biome.size;
    this.worldW = n * T;
    this.worldH = n * T;

    this.map = this.make.tilemap({ tileWidth: T, tileHeight: T, width: n, height: n });
    // margin/spacing account for the 1-art-pixel extrusion around each tile
    const key = `tileset_${biome.id}`;
    const tileset = this.map.addTilesetImage(key, key, T, T, S, S * 2);

    // Tilemap layers are culled to the camera automatically — cheap to render.
    this.groundLayer = this.map.createBlankLayer('ground', tileset).setDepth(0);
    this.roadLayer = this.map.createBlankLayer('roads', tileset).setDepth(1);

    // Meadow keeps its original seed so existing villages look the same.
    const seed = biome.id === 'meadow' ? this.state.seed : `${this.state.seed}:${biome.id}`;
    const rng = new Phaser.Math.RandomDataGenerator([seed]);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const r = rng.frac();
        const idx = r < 0.06 ? TILE_INDEX.FLOWERS : r < 0.35 ? TILE_INDEX.GRASS_ALT : TILE_INDEX.GRASS;
        this.groundLayer.putTileAt(idx, x, y);
      }
    }

    // One quad for the whole grid overlay
    this.gridOverlay = this.add.tileSprite(0, 0, this.worldW, this.worldH, 'gridcell')
      .setOrigin(0)
      .setDepth(2);

    // Darkens land you don't own yet and outlines the buildable area.
    this.landOverlay = this.add.graphics().setDepth(3);
    this.drawLand();
  }

  drawLand() {
    const T = CONFIG.TILE;
    const W = this.worldW;
    const H = this.worldH;
    const r = this.state.landRect;
    const x0 = r.x * T;
    const y0 = r.y * T;
    const s = r.size * T;
    const g = this.landOverlay.clear();
    if (r.size >= this.state.sizeOf()) return; // whole map owned
    g.fillStyle(0x0e141b, 0.55)
      .fillRect(0, 0, W, y0)                       // top
      .fillRect(0, y0 + s, W, H - y0 - s)          // bottom
      .fillRect(0, y0, x0, s)                      // left
      .fillRect(x0 + s, y0, W - x0 - s, s);        // right
    g.lineStyle(4, 0xf7e26b, 0.9).strokeRect(x0 - 2, y0 - 2, s + 4, s + 4);
  }

  /** Draw every structure that belongs to the biome on screen. */
  renderBiomeStructures() {
    const biome = this.state.activeBiome;
    for (const s of this.state.structures) if (s.biome === biome) this.renderStructure(s, false);
  }

  createCursor() {
    this.cursor = this.add.image(0, 0, 'cursor').setOrigin(0).setDepth(1000).setVisible(false);
    this.ghost = this.add.image(0, 0, 'house').setOrigin(0.5, 1).setAlpha(0.7).setDepth(999).setVisible(false);
  }

  /* ---------- Raids: raiders, projectiles, health bars ---------- */
  createRaidLayer() {
    this.hpBars = this.add.graphics().setDepth(1500);
    this.rangeRing = this.add.graphics().setDepth(998).setVisible(false);
    this.selRing = this.add.graphics().setDepth(997).setVisible(false); // inspected tower's range
    this.selectedTower = null;
    this.shots = [];
    for (let i = 0; i < 64; i++) {
      this.shots.push(this.add.image(0, 0, 'shot').setDepth(1400).setVisible(false).setActive(false));
    }
    this.raidStatusT = 0;
    this.enemyAnimT = 0;
    this.gameOver = false;
  }

  /** Sync sprites with GameState's raiders in the biome on screen and draw health bars. */
  renderRaiders(dt) {
    const T = CONFIG.TILE;
    const st = this.state;
    const biome = st.activeBiome;
    const keys = this.enemyKeys[biome];
    this.enemyAnimT += dt;
    const frame = Math.floor(this.enemyAnimT / 200) % 2;
    const g = this.hpBars.clear();

    for (const e of st.enemies) {
      if (e.biome !== biome) continue;
      const x = e.x * T;
      const y = e.y * T;
      if (!e.view) {
        e.view = this.add.image(x, y, keys[0]).setOrigin(0.5, 1).setAlpha(0).setScale(e.scale || 1);
        this.tweens.add({ targets: e.view, alpha: 1, duration: 250 });
      }
      const v = e.view;
      v.setPosition(x, y).setDepth(10 + e.y).setFlipX(e.left);
      if (v.frameIdx !== frame) { v.frameIdx = frame; v.setTexture(keys[frame]); }
      // Frost tint wins, otherwise the mutation's colour marks what you're facing.
      const tint = e.slowMs > 0 ? 0x9fdcff : (e.tint || 0);
      if (v.tintKey !== tint) {
        v.tintKey = tint;
        if (tint) v.setTint(tint); else v.clearTint();
      }
      if (e.hp < e.maxHp) {
        const w = 22;
        const top = y - v.displayHeight - 6;
        g.fillStyle(0x000000, 1).fillRect(x - w / 2 - 1, top - 1, w + 2, 5);
        g.fillStyle(0xbe2633, 1).fillRect(x - w / 2, top, w, 3);
        g.fillStyle(0xa3ce27, 1).fillRect(x - w / 2, top, w * Math.max(0, e.hp / e.maxHp), 3);
      }
    }

    // Town Hall health bar while it's under attack or damaged.
    const r = st.raids[biome];
    const hall = st.halls[biome];
    if (hall && (r.active || r.hallHp < CONFIG.HALL_HP)) {
      const w = hall.w * T - 8;
      const x = hall.tx * T + 4;
      const top = hall.ty * T - 10;
      g.fillStyle(0x000000, 1).fillRect(x - 2, top - 2, w + 4, 8);
      g.fillStyle(0xbe2633, 1).fillRect(x, top, w, 4);
      g.fillStyle(0xf7e26b, 1).fillRect(x, top, (w * r.hallHp) / CONFIG.HALL_HP, 4);
    }

    // Level pips on the base of upgraded towers.
    for (const s of st.towers) {
      if (s.biome !== biome || s.level < 2) continue;
      const n = s.level - 1;
      const x = (s.tx + s.w / 2) * T - (n * 5 - 1) / 2;
      const y = (s.ty + s.h) * T - 6;
      g.fillStyle(0x000000, 1).fillRect(x - 1, y - 1, n * 5 + 1, 6);
      for (let i = 0; i < n; i++) g.fillStyle(0xf7e26b, 1).fillRect(x + i * 5, y, 4, 4);
    }
  }

  onEnemyRemoved({ enemy: e, reason }) {
    const v = e.view;
    if (!v) return;
    e.view = null;
    this.tweens.killTweensOf(v);
    if (reason === 'killed') {
      this.tweens.add({ targets: v, alpha: 0, scaleY: v.scaleY * 0.2, duration: 220, onComplete: () => v.destroy() });
    } else {
      v.destroy();
    }
  }

  onTowerShot({ tower: s, enemy: e }) {
    if (s.biome !== this.state.activeBiome) return;
    const T = CONFIG.TILE;
    const x0 = (s.tx + 0.5) * T;
    const y0 = (s.ty + 1) * T - 32; // lookout platform
    const x1 = e.x * T;
    const y1 = e.y * T - 10;
    const view = this.cameras.main.worldView;
    if (!view.contains(x0, y0) && !view.contains(x1, y1)) return;
    let p = null;
    for (let i = 0; i < this.shots.length; i++) {
      if (!this.shots[i].active) { p = this.shots[i]; break; }
    }
    if (!p) return; // pool exhausted: skip the visual, damage is already applied
    const t = s.def.tower;
    p.setPosition(x0, y0).setTint(t.color).setScale(t.splash ? 2 : 1).setActive(true).setVisible(true);
    this.tweens.add({
      targets: p, x: x1, y: y1, duration: 140,
      onComplete: () => p.setActive(false).setVisible(false),
    });
  }

  onRaidHit({ biome, enemy }) {
    if (biome !== this.state.activeBiome) return;
    this.cameras.main.shake(220, 0.006);
    const hall = this.state.halls[biome];
    const v = hall?.view;
    if (v) {
      v.setTint(0xff6060);
      this.time.delayedCall(200, () => { if (v.active && !this.gameOver) v.clearTint(); });
    }
    const c = this.state.hallCenter(biome);
    this.spawnFloat(c.x * CONFIG.TILE, (c.y - 1) * CONFIG.TILE, `-${enemy.dmg} HP`, '#e06f8b');
  }

  onRaidWon({ biome, reward }) {
    if (!reward || biome !== this.state.activeBiome) return;
    const c = this.state.hallCenter(biome);
    this.spawnFloat(c.x * CONFIG.TILE, (c.y - 1) * CONFIG.TILE, `+${short(reward)}`, '#f7e26b');
  }

  /** Player-triggered raid: "bring it on" for the biome on screen. */
  callRaid() {
    if (this.gameOver) return;
    const res = this.state.callRaid(this.state.activeBiome);
    if (res.ok) {
      this.cameras.main.shake(180, 0.004);
      this.bus.emit('raid:status', this.state.raidSummary());
      return;
    }
    if (res.reason === 'active') this.bus.emit('toast', 'A raid is already under way!', 'warn');
  }

  /** Flip between the raid countdown and raids-only-when-you-say-so. */
  toggleRaidMode() {
    if (this.gameOver) return;
    this.state.toggleRaidMode();
    this.bus.emit('raid:status', this.state.raidSummary());
  }

  onGameOver({ biome }) {
    this.gameOver = true;
    this.isPainting = false;
    if (this.tickEvent) this.tickEvent.paused = true;
    if (biome === this.state.activeBiome) {
      this.cameras.main.shake(500, 0.012);
      const v = this.state.halls[biome]?.view;
      if (v) this.tweens.add({ targets: v, alpha: 0.35, scaleY: 0.6, duration: 600, onStart: () => v.setTint(0x493c2b) });
    }
  }

  /** Pre-allocated floating text pool for "+12" income popups. */
  createFloatPool() {
    this.floats = [];
    for (let i = 0; i < CONFIG.FLOAT_POOL_SIZE; i++) {
      const t = this.add.text(0, 0, '', {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: '8px',
        color: '#f7e26b',
        stroke: '#000000',
        strokeThickness: 3,
      }).setOrigin(0.5, 1).setDepth(2000).setVisible(false).setActive(false);
      this.floats.push(t);
    }
  }

  spawnFloat(x, y, text, color) {
    let t = null;
    for (let i = 0; i < this.floats.length; i++) {
      if (!this.floats[i].active) { t = this.floats[i]; break; }
    }
    if (!t) return; // pool exhausted: skip rather than allocate

    t.setText(text).setColor(color).setPosition(x, y).setAlpha(1).setActive(true).setVisible(true);
    this.tweens.add({
      targets: t,
      y: y - 28,
      alpha: 0,
      duration: 1100,
      ease: 'Cubic.easeOut',
      onComplete: () => t.setActive(false).setVisible(false),
    });
  }

  /* ---------- Camera ---------- */
  setupCamera() {
    const cam = this.cameras.main;
    cam.setZoom(CONFIG.ZOOM_LEVELS[this.zoomIndex]);
    cam.setRoundPixels(true);
    this.fitCamera();
  }

  /** Fit the camera to the current biome and centre it on the buildable land. */
  fitCamera() {
    const cam = this.cameras.main;
    const T = CONFIG.TILE;
    const r = this.state.landRect;
    cam.setBounds(0, 0, this.worldW, this.worldH);
    cam.centerOn((r.x + r.size / 2) * T, (r.y + r.size / 2) * T);
    this.updateGridVisibility();
  }

  /** Step through discrete zoom levels, keeping the point under the cursor fixed. */
  zoomBy(dir, pointer) {
    const next = clamp(this.zoomIndex + dir, 0, CONFIG.ZOOM_LEVELS.length - 1);
    if (next === this.zoomIndex) return;

    const cam = this.cameras.main;
    const px = pointer ? pointer.x : cam.width / 2;
    const py = pointer ? pointer.y : cam.height / 2;

    const before = cam.getWorldPoint(px, py, this.tmpVec);
    const bx = before.x;
    const by = before.y;

    this.zoomIndex = next;
    cam.setZoom(CONFIG.ZOOM_LEVELS[next]);
    cam.preRender(); // refresh the camera matrix so getWorldPoint uses the new zoom

    const after = cam.getWorldPoint(px, py, this.tmpVec);
    cam.setScroll(cam.scrollX + (bx - after.x), cam.scrollY + (by - after.y));

    this.updateGridVisibility();
    if (pointer) this.updateHover(pointer, true);
  }

  updateGridVisibility() {
    // Thin lines shimmer when zoomed far out, so hide them there.
    this.gridOverlay.setVisible(this.gridEnabled && this.cameras.main.zoom >= 1);
  }

  /* ---------- Input ---------- */
  setupInput() {
    const input = this.input;
    input.mouse?.disableContextMenu();

    this.keys = input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT');

    input.keyboard.on('keydown-Q', () => this.zoomBy(-1));
    input.keyboard.on('keydown-E', () => this.zoomBy(1));
    input.keyboard.on('keydown-G', () => {
      this.gridEnabled = !this.gridEnabled;
      this.updateGridVisibility();
    });
    input.keyboard.on('keydown-ESC', () => this.bus.emit('tool:select', 'pan'));
    input.keyboard.on('keydown-T', () => this.upgradeTickSpeed());
    input.keyboard.on('keydown-Y', () => this.buyUpgrade('towers'));
    input.keyboard.on('keydown-F', () => {
      const t = TOWER_OF_BIOME[this.state.activeBiome];
      if (t) this.bus.emit('tool:select', t.id);
    });
    // R calls the next raid in; Shift+R turns the raid clock on/off.
    input.keyboard.on('keydown-R', (e) => {
      if (e.shiftKey) this.toggleRaidMode(); else this.callRaid();
    });
    input.keyboard.on('keydown', (e) => {
      const list = TOOLS_BY_BIOME[this.state.activeBiome];
      const i = list.findIndex((_t, idx) => toolKey(idx) === e.key);
      if (i !== -1) this.bus.emit('tool:select', list[i].id);
    });

    input.on('pointerdown', this.onPointerDown, this);
    input.on('pointermove', this.onPointerMove, this);
    input.on('pointerup', this.onPointerUp, this);
    input.on('pointerupoutside', this.onPointerUp, this);
    input.on('wheel', (pointer, _over, _dx, dy) => {
      if (this.time.now - this.lastWheelAt < CONFIG.WHEEL_COOLDOWN_MS) return;
      this.lastWheelAt = this.time.now;
      this.zoomBy(dy > 0 ? -1 : 1, pointer);
    });
    input.on('gameover', () => { this.pointerInside = true; });
    input.on('gameout', () => {
      this.pointerInside = false;
      this.refreshCursor();
    });
  }

  setTool(id) {
    const t = TOOL_BY_ID[id];
    this.tool = t && (!t.biome || t.biome === this.state.activeBiome) ? t : TOOL_BY_ID.pan;
    this.isPainting = false;
    this.deselectTower();
    this.refreshCursor();
  }

  /* ---------- Tower selection & upgrades ---------- */
  selectTower(s) {
    this.selectedTower = s;
    this.drawSelectedRange();
    this.emitTowerInfo();
  }

  /** Drop the selection; `notify` also tells the HUD to go back to the tool info. */
  deselectTower(notify = false) {
    if (!this.selectedTower) return;
    this.selectedTower = null;
    this.selRing.clear().setVisible(false);
    if (notify) this.bus.emit('tower:info', null);
  }

  drawSelectedRange() {
    const s = this.selectedTower;
    if (!s) return;
    const T = CONFIG.TILE;
    const cx = (s.tx + s.w / 2) * T;
    const cy = (s.ty + s.h / 2) * T;
    const rad = s.stats.range * T;
    const color = s.def.tower.color;
    this.selRing.clear()
      .fillStyle(color, 0.1).fillCircle(cx, cy, rad)
      .lineStyle(2, color, 0.85).strokeCircle(cx, cy, rad)
      .setVisible(true);
  }

  /** Send the inspected tower's stats + upgrade price to the HUD. */
  emitTowerInfo() {
    const s = this.selectedTower;
    if (!s) return;
    const st = this.state;
    if (!st.structures.has(s) || s.biome !== st.activeBiome) {
      this.deselectTower(true); // bulldozed, cleared, or we left the biome
      return;
    }
    const cost = st.towerUpgradeCost(s);
    this.bus.emit('tower:info', {
      uid: `${s.biome}:${s.tx}:${s.ty}`,
      name: s.def.name,
      level: s.level,
      max: CONFIG.TOWER_MAX_LEVEL,
      stats: s.stats,
      next: cost ? towerStatsAt(s.def.tower, s.level + 1) : null,
      cost,
      affordable: !!cost && st.coins >= cost.coins && st.materials >= cost.materials,
      shared: !!TOWER_UPGRADE_OF[s.type],
      enemy: ENEMIES[s.biome].plural,
    });
  }

  upgradeSelectedTower() {
    const s = this.selectedTower;
    const res = this.state.upgradeTower(s);
    if (res.error) {
      this.bus.emit('toast', res.error, 'error');
      return;
    }
    if (res.shared) {
      this.onTowersUpgraded(res.level);
      return;
    }
    const T = CONFIG.TILE;
    this.drawSelectedRange();
    this.spawnFloat((s.tx + s.w / 2) * T, s.ty * T, `-${short(res.cost.coins)}`, '#e06f8b');
    this.popTower(s);
    this.bus.emit('toast', `${s.def.name} upgraded to Lv ${res.level}!`, 'good');
  }

  /** Higher-level towers glow more gold so upgrades are visible on the map. */
  tintTower(s) {
    const v = s.view;
    if (!v) return;
    const tint = [0xffffff, 0xfff4c8, 0xffe89a, 0xffdc6c, 0xffcf40][(s.level || 1) - 1] ?? 0xffcf40;
    if (tint === 0xffffff) v.clearTint(); else v.setTint(tint);
  }

  popTower(s) {
    const v = s.view;
    if (!v) return;
    this.tintTower(s);
    this.tweens.killTweensOf(v);
    v.setScale(1.25, 0.75);
    this.tweens.add({ targets: v, scaleX: 1, scaleY: 1, duration: 320, ease: 'Back.easeOut' });
  }

  /** Feedback after the shared Defense Towers upgrade: every tower on screen pops and shows its new level. */
  onTowersUpgraded(level) {
    const T = CONFIG.TILE;
    const st = this.state;
    const view = this.cameras.main.worldView;
    let shown = 0;
    for (const s of st.towers) {
      if (s.biome !== st.activeBiome) continue;
      this.popTower(s);
      const x = (s.tx + s.w / 2) * T;
      const y = s.ty * T - 24;
      if (shown < 12 && view.contains(x, y)) { this.spawnFloat(x, y, `LV ${level}`, '#a3ce27'); shown++; }
    }
    this.drawSelectedRange();
    const count = st.towers.size;
    this.bus.emit('toast', count
      ? `\u{1F3F9} ${count === 1 ? 'Your defense tower' : `All ${count} defense towers`} upgraded to Lv ${level}!`
      : `\u{1F3F9} Defense towers are now Lv ${level}. Build some with [F]!`, 'good', 2500);
  }

  onPointerDown(pointer) {
    this.pointerInside = true;
    this.lastPan.set(pointer.x, pointer.y);
    this.dragDistance = 0;

    // Right / middle drag always pans; left drag pans with the Inspect tool.
    const panButton = pointer.button === 1 || pointer.button === 2;
    if (panButton || this.tool.kind === 'pan') {
      this.isPanning = true;
      return;
    }

    if (pointer.button === 0) {
      this.isPainting = true;
      this.strokeWarned = false;
      this.lastPaintX = this.lastPaintY = -1;
      this.updateHover(pointer, true);
      this.applyTool(this.hoverX, this.hoverY, false);
    }
  }

  onPointerMove(pointer) {
    this.pointerInside = true;

    if (this.isPanning && pointer.isDown) {
      const cam = this.cameras.main;
      const dx = pointer.x - this.lastPan.x;
      const dy = pointer.y - this.lastPan.y;
      cam.scrollX -= dx / cam.zoom;
      cam.scrollY -= dy / cam.zoom;
      this.lastPan.set(pointer.x, pointer.y);
      this.dragDistance += Math.abs(dx) + Math.abs(dy);
    }

    this.updateHover(pointer);

    // Hold & drag applies the tool to every tile the cursor passes over.
    if (this.isPainting && this.tool.paint && pointer.isDown) {
      this.paintTo(this.hoverX, this.hoverY);
    }
  }

  /** Apply the tool along a line from the last painted tile, so fast drags leave no gaps. */
  paintTo(tx, ty) {
    let x = this.lastPaintX;
    let y = this.lastPaintY;
    if (x === -1 && y === -1) {
      this.applyTool(tx, ty, true);
      return;
    }
    // Bresenham line walk (the start tile was already painted). Diagonal steps are
    // split into two straight ones so painted roads always connect edge-to-edge.
    const dx = Math.abs(tx - x);
    const dy = -Math.abs(ty - y);
    const sx = x < tx ? 1 : -1;
    const sy = y < ty ? 1 : -1;
    let err = dx + dy;
    while (x !== tx || y !== ty) {
      const e2 = 2 * err;
      const stepX = e2 >= dy;
      const stepY = e2 <= dx;
      if (stepX) { err += dy; x += sx; this.applyTool(x, y, true); }
      if (stepY) { err += dx; y += sy; this.applyTool(x, y, true); }
    }
  }

  onPointerUp(pointer) {
    const wasClick = this.isPanning && this.dragDistance < CONFIG.CLICK_SLOP;
    if (wasClick && this.tool.kind === 'pan' && pointer.button === 0) {
      this.inspect(this.hoverX, this.hoverY);
    }
    this.isPanning = false;
    this.isPainting = false;
  }

  /** Convert pointer -> tile; only refresh visuals when the tile changes. */
  updateHover(pointer, force = false) {
    const p = this.cameras.main.getWorldPoint(pointer.x, pointer.y, this.tmpVec);
    const tx = Math.floor(p.x / CONFIG.TILE);
    const ty = Math.floor(p.y / CONFIG.TILE);
    if (!force && tx === this.hoverX && ty === this.hoverY) return;
    this.hoverX = tx;
    this.hoverY = ty;
    this.refreshCursor();
  }

  refreshCursor() {
    if (!this.cursor) return;
    const T = CONFIG.TILE;
    const tx = this.hoverX;
    const ty = this.hoverY;
    const visible = this.pointerInside && this.state.inBounds(tx, ty);

    this.cursor.setVisible(visible);
    this.ghost.setVisible(false);
    this.rangeRing.setVisible(false);
    if (!visible) return;

    const tool = this.tool;
    this.cursor.setPosition(tx * T, ty * T).setScale(tool.w, tool.h);

    if (tool.kind === 'build') {
      const ok = !this.state.checkPlacement(tool, tx, ty);
      if (tool.tower) {
        const cx = (tx + tool.w / 2) * T;
        const cy = (ty + tool.h / 2) * T;
        const rad = tool.tower.range * T;
        this.rangeRing.clear()
          .fillStyle(0xffffff, 0.08).fillCircle(cx, cy, rad)
          .lineStyle(2, 0xffffff, 0.6).strokeCircle(cx, cy, rad)
          .setVisible(true);
      }
      this.cursor.setTint(ok ? 0x7cff6b : 0xff4d4d);
      this.ghost
        .setTexture(tool.texture)
        .setPosition((tx + tool.w / 2) * T, (ty + tool.h) * T)
        .setTint(ok ? 0xffffff : 0xff6060)
        .setDepth(10 + ty + tool.h + 0.5)
        .setVisible(true);
    } else if (tool.kind === 'bulldoze') {
      this.cursor.setTint(this.state.at(tx, ty) ? 0xff4d4d : 0xffffff);
    } else {
      this.cursor.setTint(this.state.at(tx, ty) ? 0x31a2f2 : 0xffffff);
    }
  }

  /* ---------- Tool actions ---------- */
  applyTool(tx, ty, fromDrag) {
    if (fromDrag && tx === this.lastPaintX && ty === this.lastPaintY) return;
    this.lastPaintX = tx;
    this.lastPaintY = ty;
    if (!this.state.inBounds(tx, ty)) return;

    if (this.tool.kind === 'build') this.build(this.tool, tx, ty, fromDrag);
    else if (this.tool.kind === 'bulldoze') this.demolish(tx, ty, fromDrag);
  }

  build(def, tx, ty, quiet) {
    const res = this.state.place(def, tx, ty);
    if (res.error) {
      // While dragging, skip "occupied" noise and only warn about money once per stroke.
      if (!quiet || (!this.strokeWarned && res.error !== ERR.OCCUPIED)) {
        this.bus.emit('toast', res.error, 'error');
        this.strokeWarned = true;
      }
      return;
    }

    const s = res.structure;
    this.renderStructure(s, true);
    if (!def.isRoad) {
      const T = CONFIG.TILE;
      this.spawnFloat((tx + def.w / 2) * T, ty * T, `-${short(def.cost.coins)}`, '#e06f8b');
    }
  }

  /** Draw a structure that already exists in GameState (new placement or loaded save). */
  renderStructure(s, animate) {
    const def = s.def;
    const T = CONFIG.TILE;
    if (def.isRoad) {
      this.roadLayer.putTileAt(TILE_INDEX.ROAD, s.tx, s.ty);
      return;
    }
    s.view = this.add.image((s.tx + def.w / 2) * T, (s.ty + def.h) * T, def.texture)
      .setOrigin(0.5, 1)
      .setDepth(10 + s.ty + def.h); // lower rows draw in front
    if (def.tower) this.tintTower(s);
    if (animate) {
      // Little "pop" so placement feels juicy.
      s.view.setScale(1, 0.4);
      this.tweens.add({ targets: s.view, scaleY: 1, duration: 220, ease: 'Back.easeOut' });
    }
  }

  demolish(tx, ty, quiet) {
    const res = this.state.remove(tx, ty);
    if (!res) {
      if (!quiet) this.bus.emit('toast', 'Nothing to bulldoze', 'warn');
      return;
    }
    if (res.blocked) {
      if (!quiet) this.bus.emit('toast', "The Town Hall can't be demolished!", 'warn');
      return;
    }

    const s = res.structure;
    if (s.def.isRoad) {
      for (let y = s.ty; y < s.ty + s.h; y++) {
        for (let x = s.tx; x < s.tx + s.w; x++) this.roadLayer.removeTileAt(x, y);
      }
    } else if (s.view) {
      this.tweens.killTweensOf(s.view);
      s.view.destroy();
      s.view = null;
    }
    if (res.refund) {
      const T = CONFIG.TILE;
      this.spawnFloat((s.tx + s.w / 2) * T, s.ty * T, `+${short(res.refund)}`, '#f7e26b');
    }
  }

  /** Wipe every structure from the current biome (see GameState.clearBiome). */
  clearGrid() {
    const res = this.state.clearBiome();
    const name = BIOME_BY_ID[this.state.activeBiome].name;
    if (!res.removed.length) {
      this.bus.emit('toast', `The ${name} is already empty`, 'warn');
      return;
    }
    for (const s of res.removed) {
      if (s.def.isRoad) {
        this.roadLayer.removeTileAt(s.tx, s.ty);
      } else if (s.view) {
        this.tweens.killTweensOf(s.view);
        s.view.destroy();
        s.view = null;
      }
    }
    this.refreshCursor();
    this.bus.emit('toast', `${name} cleared! Refunded ${short(res.refund)} coins`, 'good');
  }

  /* ---------- Biomes ---------- */
  unlockBiome(id) {
    const res = this.state.unlockBiome(id);
    if (res.error) {
      this.bus.emit('toast', res.error, 'error');
      return;
    }
    const b = res.biome;
    this.travelTo(id);
    this.bus.emit('toast', `${b.icon} Unlocked the ${b.name}! ${b.size}x${b.size} of new land`, 'good', 3000);
  }

  /** Show another biome: tear down this one's visuals and build the new map. */
  travelTo(id) {
    const st = this.state;
    const biome = BIOME_BY_ID[id];
    if (!biome || id === st.activeBiome) return;
    if (!st.unlockedBiomes.has(id)) {
      this.bus.emit('toast', ERR.BIOME_LOCKED, 'error');
      return;
    }

    for (const s of st.structures) {
      if (!s.view) continue;
      this.tweens.killTweensOf(s.view);
      s.view.destroy();
      s.view = null;
    }
    for (const w of this.walkers) {
      this.tweens.killTweensOf(w.sprite);
      w.sprite.destroy();
    }
    this.walkers.length = 0;
    for (const e of st.enemies) {
      if (!e.view) continue;
      this.tweens.killTweensOf(e.view);
      e.view.destroy();
      e.view = null;
    }
    for (const p of this.shots) {
      this.tweens.killTweensOf(p);
      p.setActive(false).setVisible(false);
    }
    this.hpBars.clear();
    this.deselectTower(true);
    this.map.destroy(); // also destroys its layers
    this.gridOverlay.destroy();
    this.landOverlay.destroy();
    this.isPainting = false;

    st.setBiome(id);
    this.createWorld();
    this.renderBiomeStructures();
    this.fitCamera();
    if (this.tool.biome && this.tool.biome !== id) this.bus.emit('tool:select', 'pan');
    this.refreshCursor();
    this.cameras.main.fadeIn(350, 14, 20, 27);
    this.bus.emit('biome:entered', id);
    this.bus.emit('toast', `${biome.icon} Welcome to the ${biome.name}!`, 'good');
  }

  inspect(tx, ty) {
    const s = this.state.at(tx, ty);
    if (!s || !s.def.tower) this.deselectTower(true);
    if (!s) return;
    if (s.def.isRoad) {
      this.bus.emit('toast', 'Road', 'info');
      return;
    }
    if (s.def.hall) {
      const r = this.state.raids[s.biome];
      const enemy = this.state.raiderOf(s.biome);
      const when = r.active
        ? 'RAID IN PROGRESS!'
        : this.state.raidMode === 'manual'
          ? 'Raids on call — press R when you\'re ready.'
          : `Next raid in ${Math.ceil(r.timer / 1000)}s`;
      this.bus.emit('toast', `Town Hall: ${r.hallHp}/${CONFIG.HALL_HP} HP. ${when} (${enemy.plural})`, r.active ? 'error' : 'info', 2500);
      return;
    }
    if (s.def.tower) {
      this.selectTower(s);
      return;
    }
    const connected = this.state.isConnected(s);
    const y = this.state.structureYield(s);
    const parts = [];
    if (y.coins) parts.push(`+${short(y.coins)} coins`);
    if (y.materials) parts.push(`+${y.materials} wood`);
    const yieldText = parts.length ? ` ${parts.join(', ')}/tick` : '';
    this.bus.emit(
      'toast',
      connected
        ? `${s.def.name}:${yieldText}`
        : `${s.def.name}:${yieldText} (no road! ${Math.round(this.state.unconnectedFactor * 100)}%)`,
      connected ? 'good' : 'warn',
    );
  }

  /* ---------- Economy ---------- */
  setupEconomy() {
    this.restartEconomy();
  }

  /** (Re)create the looping tick timer at the current tick speed. */
  restartEconomy() {
    if (this.tickEvent) this.tickEvent.remove(false);
    this.tickEvent = this.time.addEvent({
      delay: this.state.tickMs,
      loop: true,
      callback: this.onTick,
      callbackScope: this,
    });
  }

  upgradeTickSpeed() {
    const res = this.state.upgradeTickSpeed();
    if (res.error) {
      this.bus.emit('toast', res.error, 'error');
      return;
    }
    this.restartEconomy();
    this.bus.emit('toast', `Faster ticks! Now every ${(res.ms / 1000).toFixed(1)}s`, 'good');
  }

  buyUpgrade(id) {
    if (id === 'tick') {
      this.upgradeTickSpeed(); // needs the timer restart above
      return;
    }
    const res = this.state.buyUpgrade(id);
    if (res.error) {
      this.bus.emit('toast', res.error, 'error');
      return;
    }
    const u = res.upgrade;
    if (u.towers) {
      this.onTowersUpgraded(res.level + 1);
      return;
    }
    this.bus.emit('toast', `${u.name} Lv ${res.level}: ${u.label(res.level * u.per)}`, 'good');
    if (id === 'land') {
      this.drawLand();
      this.refreshCursor();
    }
  }

  unlockTier(tierId) {
    const res = this.state.unlockTier(tierId);
    if (res.error) {
      this.bus.emit('toast', res.error, 'error');
      return;
    }
    const names = res.tier.buildings.map((id) => TOOL_BY_ID[id].name).join(' & ');
    this.bus.emit('toast', `Unlocked ${res.tier.name}: ${names}!`, 'good');
    this.refreshCursor();
  }

  onTick() {
    const report = this.state.tick();
    const T = CONFIG.TILE;
    const view = this.cameras.main.worldView;

    // Only spawn popups for buildings the player can actually see (other biomes still pay out).
    for (const p of report.payouts) {
      const s = p.s;
      if (s.biome !== this.state.activeBiome) continue;
      const x = (s.tx + s.w / 2) * T;
      const y = s.ty * T;
      if (!view.contains(x, y)) continue;
      if (p.coins) this.spawnFloat(x, y, `+${short(p.coins)}`, '#f7e26b');
      else if (p.materials) this.spawnFloat(x, y, `+${p.materials}`, '#eb8931');
    }
    this.bus.emit('tick', report);
  }

  /* ---------- Villagers walking along the roads ---------- */
  /** More residents = busier streets. Never more walkers than road tiles. */
  desiredWalkers() {
    const roads = this.state.roadsIn().length;
    if (!roads) return 0;
    const want = CONFIG.WALKER_BASE + Math.floor(this.state.population / CONFIG.RESIDENTS_PER_WALKER);
    return Math.min(CONFIG.WALKER_MAX, roads, want);
  }

  spawnWalker() {
    const roads = this.state.roadsIn();
    if (!roads.length) return;

    const T = CONFIG.TILE;
    const r = Phaser.Utils.Array.GetRandom(roads);
    const look = Phaser.Math.Between(0, WALKER_LOOKS.length - 1);
    const ox = Phaser.Math.Between(-8, 8); // personal "lane" so walkers don't stack
    const oy = Phaser.Math.Between(-6, 10);
    const x = (r.tx + 0.5) * T + ox;
    const y = (r.ty + 0.5) * T + oy;
    const sprite = this.add.image(x, y, this.walkerKeys[look][0])
      .setOrigin(0.5, 1)
      .setDepth(10 + y / T)
      .setAlpha(0);
    this.tweens.add({ targets: sprite, alpha: 1, duration: 300 });

    this.walkers.push({
      sprite, look, ox, oy,
      tx: r.tx, ty: r.ty,          // tile currently heading to
      prevTx: -1, prevTy: -1,      // tile just left (avoid instant U-turns)
      speed: Phaser.Math.FloatBetween(CONFIG.WALKER_SPEED_MIN, CONFIG.WALKER_SPEED_MAX),
      frame: 0, frameT: 0,
      wait: Phaser.Math.Between(0, 800),
    });
  }

  removeWalker(w) {
    const i = this.walkers.indexOf(w);
    if (i !== -1) this.walkers.splice(i, 1);
    const sprite = w.sprite;
    this.tweens.killTweensOf(sprite);
    this.tweens.add({ targets: sprite, alpha: 0, duration: 250, onComplete: () => sprite.destroy() });
  }

  /** Choose the next connected road tile, preferring to keep walking straight. */
  pickNextTile(w) {
    const st = this.state;
    const opts = this.walkerOpts;
    opts.length = 0;
    let straight = -1;
    const fdx = w.prevTx >= 0 ? w.tx - w.prevTx : 0;
    const fdy = w.prevTx >= 0 ? w.ty - w.prevTy : 0;
    for (let i = 0; i < WALKER_DIRS.length; i++) {
      const [dx, dy] = WALKER_DIRS[i];
      const nx = w.tx + dx;
      const ny = w.ty + dy;
      if (nx === w.prevTx && ny === w.prevTy) continue;
      if (!st.isRoad(nx, ny)) continue;
      if (dx === fdx && dy === fdy) straight = i;
      opts.push(i);
    }

    let nx;
    let ny;
    if (opts.length) {
      const d = straight !== -1 && Math.random() < 0.6 ? straight : Phaser.Utils.Array.GetRandom(opts);
      nx = w.tx + WALKER_DIRS[d][0];
      ny = w.ty + WALKER_DIRS[d][1];
    } else if (w.prevTx >= 0 && st.isRoad(w.prevTx, w.prevTy)) {
      nx = w.prevTx; // dead end: turn around
      ny = w.prevTy;
    } else {
      // Lone road tile: shuffle around on it.
      w.ox = Phaser.Math.Between(-8, 8);
      w.oy = Phaser.Math.Between(-6, 10);
      w.wait = Phaser.Math.Between(600, 1800);
      return;
    }

    w.prevTx = w.tx;
    w.prevTy = w.ty;
    w.tx = nx;
    w.ty = ny;
    if (Math.random() < CONFIG.WALKER_PAUSE_CHANCE) w.wait = Phaser.Math.Between(500, 2000);
  }

  updateWalker(w, dt) {
    const st = this.state;
    // The road ahead was bulldozed: turn back, or leave if they're stranded.
    if (!st.isRoad(w.tx, w.ty)) {
      if (w.prevTx >= 0 && st.isRoad(w.prevTx, w.prevTy)) {
        w.tx = w.prevTx;
        w.ty = w.prevTy;
        w.prevTx = w.prevTy = -1;
      } else {
        this.removeWalker(w);
        return;
      }
    }

    const sp = w.sprite;
    if (w.wait > 0) {
      w.wait -= dt;
      if (w.frame !== 0) { w.frame = 0; sp.setTexture(this.walkerKeys[w.look][0]); }
      return;
    }

    const T = CONFIG.TILE;
    const gx = (w.tx + 0.5) * T + w.ox;
    const gy = (w.ty + 0.5) * T + w.oy;
    const dx = gx - sp.x;
    const dy = gy - sp.y;
    const dist = Math.hypot(dx, dy);
    const step = (w.speed * dt) / 1000;
    if (dist <= step) {
      sp.setPosition(gx, gy);
      this.pickNextTile(w);
    } else {
      sp.x += (dx / dist) * step;
      sp.y += (dy / dist) * step;
      if (Math.abs(dx) > 0.5) sp.setFlipX(dx < 0);
    }
    sp.setDepth(10 + sp.y / T); // feet position decides who's in front of buildings

    w.frameT += dt;
    if (w.frameT >= CONFIG.WALKER_FRAME_MS) {
      w.frameT = 0;
      w.frame ^= 1;
      sp.setTexture(this.walkerKeys[w.look][w.frame]);
    }
  }

  updateWalkers(dt) {
    this.walkerSpawnT -= dt;
    if (this.walkerSpawnT <= 0) {
      this.walkerSpawnT = CONFIG.WALKER_SPAWN_MS;
      const want = this.desiredWalkers();
      if (this.walkers.length < want) this.spawnWalker();
      else if (this.walkers.length > want) this.removeWalker(this.walkers[0]);
    }
    // Iterate backwards: walkers may remove themselves.
    for (let i = this.walkers.length - 1; i >= 0; i--) this.updateWalker(this.walkers[i], dt);
  }

  /* ---------- Frame loop: keep it tiny ---------- */
  update(_time, delta) {
    const dt = Math.min(delta, 100); // clamp so a backgrounded tab doesn't teleport anyone
    this.updateWalkers(dt);
    if (!this.gameOver) this.state.updateRaids(dt);
    this.renderRaiders(dt);
    this.raidStatusT -= dt;
    if (this.raidStatusT <= 0) {
      this.raidStatusT = 250;
      this.bus.emit('raid:status', this.state.raidSummary());
    }

    const k = this.keys;
    const dx = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    const dy = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
    if (!dx && !dy) return;

    const cam = this.cameras.main;
    const norm = dx && dy ? Math.SQRT1_2 : 1;
    const step = (CONFIG.PAN_SPEED * (delta / 1000) * norm) / cam.zoom; // constant screen speed
    cam.scrollX += dx * step;
    cam.scrollY += dy * step;

    if (this.pointerInside) this.updateHover(this.input.activePointer);
  }
}

/* ==========================================================================
 * 7. Boot
 * ======================================================================== */
(function boot() {
  const bus = new Phaser.Events.EventEmitter();
  const state = new GameState(bus);
  new UIController(bus); // eslint-disable-line no-new

  /* ---------- Save system (localStorage) ---------- */
  let resetting = false; // stops the unload handler re-saving after "New Game"

  const save = (manual = false) => {
    if (resetting) return;
    try {
      localStorage.setItem(CONFIG.SAVE_KEY, JSON.stringify(state.serialize()));
      if (manual) bus.emit('toast', 'Game saved!', 'good');
    } catch (err) {
      if (manual) bus.emit('toast', 'Save failed (storage unavailable)', 'error');
    }
  };

  let loaded = false;
  try {
    const raw = localStorage.getItem(CONFIG.SAVE_KEY);
    if (raw) loaded = state.load(JSON.parse(raw));
  } catch (err) {
    console.warn('Could not load save, starting fresh.', err);
  }
  state.ensureHalls(); // new games (and saves from before raids) get their Town Halls

  bus.on('save', () => save(true));
  bus.on('tick', () => save());
  bus.on('gameover', () => {
    // The village has fallen: wipe the save so a reload starts fresh.
    resetting = true;
    try { localStorage.removeItem(CONFIG.SAVE_KEY); } catch (err) { /* ignore */ }
  });
  bus.on('newgame', () => {
    if (!window.confirm('Start a new game? Your current village will be deleted.')) return;
    resetting = true;
    try { localStorage.removeItem(CONFIG.SAVE_KEY); } catch (err) { /* ignore */ }
    window.location.reload();
  });
  setInterval(() => save(), CONFIG.AUTOSAVE_MS);
  window.addEventListener('pagehide', () => save());
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

  const start = () => {
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game-container',
      backgroundColor: '#0e141b',
      pixelArt: true,        // nearest-neighbour filtering + no antialias
      roundPixels: true,
      banner: false,
      disableContextMenu: true,
      fps: { target: 60, smoothStep: true },
      scale: {
        mode: Phaser.Scale.RESIZE, // canvas tracks #game-container size
        width: '100%',
        height: '100%',
      },
    });
    game.scene.add('Village', VillageScene, true, { bus, state });
    if (loaded) {
      const off = state.offlineReport;
      let msg = 'Welcome back! Progress loaded.';
      if (off) {
        const mins = Math.max(1, Math.round(off.ms / 60000));
        const away = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
        const wood = off.materials ? ` & ${fmt(off.materials)} wood` : '';
        msg = `Welcome back! Earned ${short(off.coins)} coins${wood} in ${away}`;
      }
      bus.once('ready', () => setTimeout(() => bus.emit('toast', msg, 'good', off ? 4500 : 1800), 0));
    }

    // Handy for debugging in DevTools: __village.state.coins += 1000
    window.__village = { game, state, bus };
  };

  // Wait briefly for the pixel font so canvas text uses it (don't block forever offline).
  const fontReady = document.fonts ? document.fonts.load('8px "Press Start 2P"') : Promise.resolve();
  Promise.race([fontReady, new Promise((r) => setTimeout(r, 1500))])
    .catch(() => {})
    .then(start);
})();
