<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import {
  initializeScoreDatabase,
  listScoresFromSqlite,
  insertScoreIntoSqlite,
} from '@/lib/gameSqlite'

// ---- Grid & Speed Constants ----
const GRID_SIZE = 20                // 20x20 grid
const CELL_SIZE = 20                // pixels per cell
const CANVAS_SIZE = GRID_SIZE * CELL_SIZE
const BASE_INTERVAL = 150           // ms between moves at level 1
const MIN_INTERVAL = 100            // fastest speed cap
const LEVEL_STEP = 50               // points per level-up
const MAX_LEADERBOARD = 10          // top N scores saved

// ---- Type Definitions ----
interface Point { x: number; y: number }
interface LeaderboardEntry { name: string; score: number; date: string; mode: GameMode }
interface ExplosionZone { x: number; y: number; size: number; startTime: number; duration: number }

type GameMode = 'normal' | 'two-head' | 'no-wall' | 'explosion'

// Display names for each game mode
const modeNames: Record<GameMode, string> = {
  'normal': '普通',
  'two-head': '雙頭蛇',
  'no-wall': '無邊界',
  'explosion': '爆炸',
}

// ---- DOM Refs ----
const canvasRef = ref<HTMLCanvasElement | null>(null)
const scoreDisplay = ref<HTMLSpanElement | null>(null)
const levelDisplay = ref<HTMLSpanElement | null>(null)
const statusDisplay = ref<HTMLSpanElement | null>(null)
const startBtn = ref<HTMLButtonElement | null>(null)

// ---- Reactive State ----
const snake = ref<Point[]>([])
const foods = ref<Point[]>([])
const direction = ref<Point>({ x: 1, y: 0 })       // current movement direction
const nextDirection = ref<Point>({ x: 1, y: 0 })    // buffered next direction (prevents 180° turn)
const score = ref(0)
const level = ref(1)
const gameStatus = ref<'idle' | 'playing' | 'gameover'>('idle')
const gameMode = ref<GameMode>('normal')
const isPaused = ref(false)
const lbMode = ref<GameMode>('normal')               // which mode's leaderboard to show

const leaderboard = ref<LeaderboardEntry[]>([])
const showScoreConfirm = ref(false)
const showNameInput = ref(false)
const playerName = ref('')

const explosionZones = ref<ExplosionZone[]>([])

// ---- Internal Timers ----
let gameInterval: ReturnType<typeof setInterval> | null = null
let rafId: number | null = null
let explosionTimer: ReturnType<typeof setInterval> | null = null

// ---- Leaderboard (SQLite + IndexedDB) ----

async function loadLeaderboard() {
  try {
    await initializeScoreDatabase()
    leaderboard.value = listScoresFromSqlite().slice(0, MAX_LEADERBOARD) as LeaderboardEntry[]
  } catch {
    // fallback: localStorage
    try {
      const data = localStorage.getItem('snake-leaderboard')
      if (data) leaderboard.value = JSON.parse(data)
    } catch { /* ignore corrupt data */ }
  }
}

async function refreshLeaderboard() {
  leaderboard.value = listScoresFromSqlite().slice(0, MAX_LEADERBOARD) as LeaderboardEntry[]
}

// Filter leaderboard entries for the currently selected mode tab
function modeLeaderboard(): LeaderboardEntry[] {
  return leaderboard.value.filter(e => e.mode === lbMode.value)
}

// Check if current score qualifies for the top 10 of this mode
function isHighScore(): boolean {
  if (score.value === 0) return false
  const lb = modeLeaderboard()
  if (lb.length < MAX_LEADERBOARD) return true
  const last = lb[lb.length - 1]
  return last ? score.value > last.score : true
}

// Save score with mode tag, sort descending, keep top 10
async function submitScore() {
  const name = playerName.value.trim() || '匿名玩家'
  try {
    await insertScoreIntoSqlite(name, score.value, new Date().toLocaleDateString(), gameMode.value)
    await refreshLeaderboard()
  } catch {
    // fallback: in-memory
    leaderboard.value.push({ name, score: score.value, date: new Date().toLocaleDateString(), mode: gameMode.value })
    leaderboard.value.sort((a, b) => b.score - a.score)
    leaderboard.value = leaderboard.value.slice(0, MAX_LEADERBOARD)
  }
  showNameInput.value = false
  playerName.value = ''
}

// Spawn (level+1) foods at random free cells, up to 6 at once.
// All must be eaten before the next batch spawns.
function generateFoods() {
  const totalCells = GRID_SIZE * GRID_SIZE
  if (snake.value.length >= totalCells) {
    foods.value = []
    return
  }
  const taken = new Set(snake.value.map(s => `${s.x},${s.y}`))
  foods.value.forEach(f => taken.add(`${f.x},${f.y}`))
  const freeCells: Point[] = []
  for (let x = 0; x < GRID_SIZE; x++) {
    for (let y = 0; y < GRID_SIZE; y++) {
      if (!taken.has(`${x},${y}`)) {
        freeCells.push({ x, y })
      }
    }
  }
  const count = Math.min(level.value + 1, 6)
  const shuffled = freeCells.sort(() => Math.random() - 0.5)
  foods.value = shuffled.slice(0, Math.min(count, shuffled.length))
}

// ---- Explosion Mode ----

// Check if the snake overlaps with a given explosion zone
function isSnakeInZone(zone: ExplosionZone): boolean {
  return snake.value.some(s =>
    s.x >= zone.x && s.x < zone.x + zone.size &&
    s.y >= zone.y && s.y < zone.y + zone.size
  )
}

// Continually redraw while explosion zones are active (needed for flash animation)
function renderLoop() {
  draw()
  if (explosionZones.value.length > 0) {
    rafId = requestAnimationFrame(renderLoop)
  } else {
    rafId = null
  }
}

function startRenderLoop() {
  if (rafId) return
  rafId = requestAnimationFrame(renderLoop)
}

// Create a random explosion zone (3x3 to 7x7) on the grid
function spawnExplosion() {
  if (gameStatus.value !== 'playing' || gameMode.value !== 'explosion' || isPaused.value) return
  const size = 3 + Math.floor(Math.random() * 5)
  const x = Math.floor(Math.random() * (GRID_SIZE - size + 1))
  const y = Math.floor(Math.random() * (GRID_SIZE - size + 1))
  explosionZones.value.push({ x, y, size, startTime: Date.now(), duration: 1300 })
  startRenderLoop()
}

// Spawn interval shrinks with level (4000ms → min 2000ms with random jitter)
function startExplosionTimer() {
  stopExplosionTimer()
  const interval = Math.max(2000, 4000 - (level.value - 1) * 300)
  explosionTimer = setInterval(spawnExplosion, interval + Math.random() * 1500)
}

function stopExplosionTimer() {
  if (explosionTimer) {
    clearInterval(explosionTimer)
    explosionTimer = null
  }
  explosionZones.value = []
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

// ---- Canvas Rendering ----

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

  // Grid lines
  ctx.strokeStyle = '#4a6a8a'
  ctx.lineWidth = 0.5
  for (let i = 0; i <= GRID_SIZE; i++) {
    ctx.beginPath()
    ctx.moveTo(i * CELL_SIZE, 0)
    ctx.lineTo(i * CELL_SIZE, CANVAS_SIZE)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i * CELL_SIZE)
    ctx.lineTo(CANVAS_SIZE, i * CELL_SIZE)
    ctx.stroke()
  }

  // Explosion zones (drawn below snake & food)
  const now = Date.now()
  const BOOM_START = 1000   // ms: flash phase → solid boom phase
  const alive: ExplosionZone[] = []
  for (const z of explosionZones.value) {
    const elapsed = now - z.startTime
    if (elapsed >= z.duration) {
      if (!isPaused.value && isSnakeInZone(z)) {
        const remove = Math.min(4, snake.value.length - 3)
        if (remove > 0) snake.value.splice(snake.value.length - remove, remove)
        if (snake.value.length <= 3) { gameOver(); return }
      }
      continue
    }
    alive.push(z)
    if (elapsed >= BOOM_START) {
      // Solid red/orange boom phase (300ms)
      ctx.fillStyle = 'rgba(255, 80, 20, 0.7)'
      ctx.fillRect(z.x * CELL_SIZE, z.y * CELL_SIZE, z.size * CELL_SIZE, z.size * CELL_SIZE)
      ctx.shadowColor = '#ff4400'
      ctx.shadowBlur = 20
      ctx.strokeStyle = '#ff4400'
      ctx.lineWidth = 3
      ctx.strokeRect(z.x * CELL_SIZE, z.y * CELL_SIZE, z.size * CELL_SIZE, z.size * CELL_SIZE)
      ctx.shadowBlur = 0
    } else {
      // Flashing warning phase (1s)
      const flash = Math.floor(elapsed / 80) % 2 === 0
      ctx.fillStyle = flash ? 'rgba(255, 50, 50, 0.45)' : 'rgba(255, 0, 0, 0.12)'
      ctx.fillRect(z.x * CELL_SIZE, z.y * CELL_SIZE, z.size * CELL_SIZE, z.size * CELL_SIZE)
      ctx.strokeStyle = flash ? '#ff3333' : '#881111'
      ctx.lineWidth = flash ? 2.5 : 1
      ctx.strokeRect(z.x * CELL_SIZE, z.y * CELL_SIZE, z.size * CELL_SIZE, z.size * CELL_SIZE)
    }
  }
  explosionZones.value = alive

  // Snake body
  snake.value.forEach((seg, i) => {
    const isHead = i === 0
    ctx.fillStyle = isHead ? '#4fc3f7' : '#26a69a'
    ctx.shadowColor = isHead ? '#4fc3f7' : '#26a69a'
    ctx.shadowBlur = isHead ? 8 : 4
    ctx.fillRect(seg.x * CELL_SIZE + 1, seg.y * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2)
    ctx.shadowBlur = 0
  })

  // Food items (rotating hues per index)
  foods.value.forEach((f, i) => {
    const hue = (i * 60) % 360
    ctx.fillStyle = `hsl(${hue}, 80%, 55%)`
    ctx.shadowColor = ctx.fillStyle
    ctx.shadowBlur = 10
    ctx.beginPath()
    ctx.arc(f.x * CELL_SIZE + CELL_SIZE / 2, f.y * CELL_SIZE + CELL_SIZE / 2, CELL_SIZE / 2 - 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  })
}

// ---- HUD Update ----

function updateDisplay() {
  if (scoreDisplay.value) scoreDisplay.value.textContent = String(score.value)
  if (levelDisplay.value) levelDisplay.value.textContent = String(level.value)
}

// Recreate the game tick interval at the current speed level
function updateSpeed() {
  if (!gameInterval) return
  clearInterval(gameInterval)
  const interval = Math.max(MIN_INTERVAL, BASE_INTERVAL - (level.value - 1) * 10)
  gameInterval = setInterval(move, interval)
}

// Check if score crossed a level boundary, then level up
function checkLevelUp() {
  const newLevel = Math.floor(score.value / LEVEL_STEP) + 1
  if (newLevel !== level.value) {
    level.value = newLevel
    updateDisplay()
    updateSpeed()
    if (gameMode.value === 'explosion') startExplosionTimer()
  }
}

// ---- Core Game Tick ----

function move() {
  if (isPaused.value) return
  direction.value = { ...nextDirection.value }
  const head = snake.value[0]
  if (!head) return
  let newHead: Point = {
    x: head.x + direction.value.x,
    y: head.y + direction.value.y,
  }

  // Mode: wrap edges instead of dying
  if (gameMode.value === 'no-wall') {
    if (newHead.x < 0) newHead.x = GRID_SIZE - 1
    if (newHead.x >= GRID_SIZE) newHead.x = 0
    if (newHead.y < 0) newHead.y = GRID_SIZE - 1
    if (newHead.y >= GRID_SIZE) newHead.y = 0
  } else {
    if (newHead.x < 0 || newHead.x >= GRID_SIZE || newHead.y < 0 || newHead.y >= GRID_SIZE) {
      gameOver()
      return
    }
  }

  // Self-collision check
  for (const seg of snake.value) {
    if (seg.x === newHead.x && seg.y === newHead.y) {
      gameOver()
      return
    }
  }

  snake.value.unshift(newHead)

  // Check if food was eaten
  const eatenIdx = foods.value.findIndex(f => f.x === newHead.x && f.y === newHead.y)
  if (eatenIdx !== -1) {
    foods.value.splice(eatenIdx, 1)

    // Mode: reverse snake + head direction away from body
    if (gameMode.value === 'two-head' && snake.value.length >= 2) {
      snake.value.reverse()
      const s0 = snake.value[0]!
      const s1 = snake.value[1]!
      const awayDir: Point = {
        x: s0.x - s1.x,
        y: s0.y - s1.y,
      }
      direction.value = { ...awayDir }
      nextDirection.value = { ...awayDir }
    }

    score.value += 10
    updateDisplay()
    checkLevelUp()

    // Generate next batch when all foods are eaten
    if (foods.value.length === 0) {
      if (snake.value.length >= GRID_SIZE * GRID_SIZE) {
        winGame()
      } else {
        generateFoods()
      }
    }
  } else {
    snake.value.pop()   // remove tail (didn't eat)
  }

  draw()
}

// ---- Game Lifecycle ----

// Snake fills the entire grid → win
function winGame() {
  gameStatus.value = 'idle'
  if (gameInterval) {
    clearInterval(gameInterval)
    gameInterval = null
  }
  if (statusDisplay.value) statusDisplay.value.textContent = '🎉 你贏了！'
  if (startBtn.value) startBtn.value.textContent = '開始'
  stopExplosionTimer()
  draw()
}

function confirmRecordScore() {
  showScoreConfirm.value = false
  showNameInput.value = true
}

function skipRecordScore() {
  showScoreConfirm.value = false
}

// Stop game, show game-over UI, prompt for leaderboard if high score
function gameOver() {
  gameStatus.value = 'gameover'
  if (gameInterval) {
    clearInterval(gameInterval)
    gameInterval = null
  }
  stopExplosionTimer()
  if (statusDisplay.value) statusDisplay.value.textContent = '💀 遊戲結束'
  if (startBtn.value) startBtn.value.textContent = '重新開始'
  draw()
  showScoreConfirm.value = isHighScore()
}

// Reset all state to starting position
function initGame() {
  isPaused.value = false
  stopExplosionTimer()
  const startX = Math.floor(GRID_SIZE / 2)
  const startY = Math.floor(GRID_SIZE / 2)
  snake.value = [
    { x: startX, y: startY },
    { x: startX - 1, y: startY },
    { x: startX - 2, y: startY },
  ]
  direction.value = { x: 1, y: 0 }
  nextDirection.value = { x: 1, y: 0 }
  score.value = 0
  level.value = 1
  updateDisplay()
  generateFoods()
  gameStatus.value = 'idle'
  if (statusDisplay.value) statusDisplay.value.textContent = '按「開始」遊玩'
  draw()
}

// Begin playing from idle or game-over state
function startGame() {
  if (gameInterval) {
    clearInterval(gameInterval)
    gameInterval = null
  }
  if (gameStatus.value === 'gameover' || gameStatus.value === 'idle') {
    initGame()
  }
  gameStatus.value = 'playing'
  if (startBtn.value) startBtn.value.textContent = '進行中'
  if (statusDisplay.value) statusDisplay.value.textContent = '▶ 遊玩中'
  gameInterval = setInterval(move, BASE_INTERVAL)
  if (gameMode.value === 'explosion') {
    startExplosionTimer()
  }
}

// Full reset to idle
function resetGame() {
  if (gameInterval) {
    clearInterval(gameInterval)
    gameInterval = null
  }
  stopExplosionTimer()
  initGame()
  if (startBtn.value) startBtn.value.textContent = '開始'
}

// Toggle pause via button or keyboard
function togglePause() {
  if (gameStatus.value !== 'playing') return
  isPaused.value = !isPaused.value
  if (statusDisplay.value) {
    statusDisplay.value.textContent = isPaused.value ? '⏸ 暫停中' : '▶ 遊玩中'
  }
}

// Switch game mode (triggers reset, also follows leaderboard tab)
function changeMode(mode: GameMode) {
  if (mode === gameMode.value) return
  gameMode.value = mode
  lbMode.value = mode
  resetGame()
}

// Switch leaderboard tab independently
function setLbMode(mode: GameMode) {
  lbMode.value = mode
}

// ---- Input Handling ----

// Buffer the next direction, rejecting 180° reversal into self
function changeDirection(newDir: Point) {
  if (gameStatus.value !== 'playing' || isPaused.value) return
  const opposite = direction.value.x + newDir.x === 0 && direction.value.y + newDir.y === 0
  if (!opposite) {
    nextDirection.value = newDir
  }
}

// Keyboard handler: WASD / arrows for movement, Space to start, Esc/P to pause
function handleKeydown(e: KeyboardEvent) {
  if (showNameInput.value || showScoreConfirm.value) return
  switch (e.key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      e.preventDefault()
      changeDirection({ x: 0, y: -1 })
      break
    case 'ArrowDown':
    case 's':
    case 'S':
      e.preventDefault()
      changeDirection({ x: 0, y: 1 })
      break
    case 'ArrowLeft':
    case 'a':
    case 'A':
      e.preventDefault()
      changeDirection({ x: -1, y: 0 })
      break
    case 'ArrowRight':
    case 'd':
    case 'D':
      e.preventDefault()
      changeDirection({ x: 1, y: 0 })
      break
    case ' ':
      e.preventDefault()
      if (gameStatus.value === 'idle' || gameStatus.value === 'gameover') {
        startGame()
      }
      break
    case 'Escape':
    case 'p':
    case 'P':
      e.preventDefault()
      togglePause()
      break
  }
}

// ---- Lifecycle ----
onMounted(async () => {
  await loadLeaderboard()
  initGame()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  if (gameInterval) clearInterval(gameInterval)
  stopExplosionTimer()
  if (rafId) cancelAnimationFrame(rafId)
})
</script>

<template>
  <div class="game-wrapper">
    <!-- Left: Game Panel -->
    <div class="game-container">
      <!-- Mode selection tabs -->
      <div class="mode-tabs">
        <button
          v-for="(name, key) in modeNames"
          :key="key"
          :class="['mode-tab', { active: gameMode === key }]"
          @click="changeMode(key as GameMode)"
        >
          {{ name }}
        </button>
      </div>

      <!-- HUD: score, level, status -->
      <div class="header">
        <div class="header-left">
          <span class="score">分數: <span ref="scoreDisplay">0</span></span>
          <span class="level">Lv.<span ref="levelDisplay">1</span></span>
        </div>
        <span ref="statusDisplay" class="status">按「開始」遊玩</span>
      </div>

      <!-- Game canvas with pause overlay -->
      <div class="canvas-wrapper">
        <canvas
          ref="canvasRef"
          :width="CANVAS_SIZE"
          :height="CANVAS_SIZE"
        />
        <div v-if="isPaused" class="pause-overlay">
          <span class="pause-text">⏸ 暫停</span>
        </div>
      </div>

      <!-- Control buttons -->
      <div class="controls">
        <button ref="startBtn" class="btn-start" @click="startGame">開始</button>
        <button
          v-if="gameStatus === 'playing'"
          class="btn-pause"
          @click="togglePause"
        >
          {{ isPaused ? '繼續' : '暫停' }}
        </button>
        <button class="btn-reset" @click="resetGame">重置</button>
      </div>
      <div class="hint">WASD / 方向鍵 · Esc/P 暫停</div>
    </div>

    <!-- Right: Leaderboard -->
    <div class="leaderboard">
      <h3>🏆 排行榜</h3>
      <!-- Per-mode leaderboard tabs -->
      <div class="lb-mode-tabs">
        <button
          v-for="(name, key) in modeNames"
          :key="key"
          :class="['lb-mode-tab', { active: lbMode === key }]"
          @click="setLbMode(key as GameMode)"
        >
          {{ name }}
        </button>
      </div>
      <div
        v-if="modeLeaderboard().length === 0"
        class="lb-empty"
      >
        尚無記錄
      </div>
      <div
        v-for="(entry, i) in modeLeaderboard()"
        :key="i"
        class="lb-row"
      >
        <span class="lb-rank">{{ i + 1 }}</span>
        <span class="lb-name">{{ entry.name }}</span>
        <span class="lb-score">{{ entry.score }}</span>
      </div>
    </div>

    <!-- Score confirmation modal -->
    <div v-if="showScoreConfirm" class="modal-overlay">
      <div class="modal">
        <h3>🎉 {{ score }} 分</h3>
        <p>是否要記錄到排行榜？</p>
        <div class="modal-btns">
          <button class="btn-start" @click="confirmRecordScore">是</button>
          <button class="btn-reset" @click="skipRecordScore">否</button>
        </div>
      </div>
    </div>

    <!-- Name input modal -->
    <div v-if="showNameInput" class="modal-overlay" @click.self="showNameInput = false">
      <div class="modal">
        <h3>🎉 新紀錄！{{ score }} 分</h3>
        <p>輸入名稱以儲存排行榜</p>
        <input
          v-model="playerName"
          placeholder="你的名字"
          maxlength="12"
          @keydown="e => { if (e.key === 'Enter') submitScore() }"
        />
        <button class="btn-start" @click="submitScore">確定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---- Layout ---- */

.game-wrapper {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

.game-container {
  background: #16213e;
  padding: 24px;
  border-radius: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  text-align: center;
}

/* ---- Mode Tabs ---- */

.mode-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
}

.mode-tab {
  flex: 1;
  padding: 8px 10px;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  border: 2px solid #0f3460;
  border-radius: 8px;
  background: transparent;
  color: #888;
  cursor: pointer;
  transition: all 0.2s;
}

.mode-tab.active {
  background: #0f3460;
  color: #4fc3f7;
  border-color: #4fc3f7;
}

.mode-tab:hover:not(.active) {
  border-color: #4fc3f7;
  color: #aaa;
}

/* ---- HUD ---- */

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  color: #e0e0e0;
}

.header-left {
  display: flex;
  gap: 20px;
  align-items: center;
}

.score {
  font-size: 24px;
  font-weight: bold;
  color: #4fc3f7;
}

.level {
  font-size: 18px;
  color: #aed581;
  background: #1e2a4a;
  padding: 4px 12px;
  border-radius: 8px;
}

/* ---- Canvas & Pause Overlay ---- */

.canvas-wrapper {
  position: relative;
  display: inline-block;
}

canvas {
  border: 2px solid #0f3460;
  border-radius: 4px;
  background: #1e2a4a;
  display: block;
}

.controls {
  margin-top: 16px;
  display: flex;
  gap: 12px;
  justify-content: center;
}

/* ---- Buttons ---- */

button:not(.lb-mode-tab) {
  padding: 10px 28px;
  font-size: 16px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}

.btn-start {
  background: #4fc3f7;
  color: #0a0a23;
}
.btn-start:hover { background: #29b6f6; }

.btn-pause {
  background: #ffd54f;
  color: #0a0a23;
}
.btn-pause:hover { background: #ffca28; }

.btn-reset {
  background: #e57373;
  color: #fff;
}
.btn-reset:hover { background: #ef5350; }

.status {
  color: #ffd54f;
  font-size: 18px;
}

.hint {
  color: #888;
  margin-top: 12px;
  font-size: 14px;
}

.pause-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  pointer-events: none;
}

.pause-text {
  font-size: 36px;
  font-weight: bold;
  color: #4fc3f7;
  text-shadow: 0 0 20px rgba(79, 195, 247, 0.6);
}

/* ---- Leaderboard ---- */

.leaderboard {
  background: #16213e;
  padding: 20px;
  border-radius: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  color: #e0e0e0;
  min-width: 200px;
}

.leaderboard h3 {
  margin-bottom: 12px;
  font-size: 18px;
  text-align: center;
}

.lb-mode-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}

.lb-mode-tab {
  flex: 1;
  padding: 4px 6px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid #0f3460;
  border-radius: 4px;
  background: transparent;
  color: #666;
  cursor: pointer;
  transition: all 0.15s;
}

.lb-mode-tab.active {
  background: #0f3460;
  color: #4fc3f7;
  border-color: #4fc3f7;
}

.lb-mode-tab:hover:not(.active) {
  border-color: #4fc3f7;
  color: #999;
}

.lb-empty {
  text-align: center;
  color: #666;
  font-size: 14px;
}

.lb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid #1e2a4a;
  font-size: 14px;
}

.lb-row:last-child { border-bottom: none; }

.lb-rank {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #0f3460;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
  color: #4fc3f7;
}

.lb-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lb-score {
  font-weight: bold;
  color: #ffd54f;
}

/* ---- Modals ---- */

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  background: #16213e;
  padding: 32px;
  border-radius: 16px;
  text-align: center;
  color: #e0e0e0;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
}

.modal h3 {
  margin-bottom: 8px;
  font-size: 22px;
}

.modal p {
  margin-bottom: 16px;
  color: #888;
  font-size: 14px;
}

.modal input {
  padding: 10px 16px;
  font-size: 16px;
  border: 2px solid #0f3460;
  border-radius: 8px;
  background: #0a0a23;
  color: #e0e0e0;
  outline: none;
  width: 200px;
  margin-bottom: 16px;
}

.modal input:focus { border-color: #4fc3f7; }

.modal-btns {
  display: flex;
  gap: 12px;
  justify-content: center;
}

.modal button { display: block; margin: 0 auto; }
</style>
