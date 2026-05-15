# 貪食蛇遊戲 — Vue 專案建置計劃

## 三大階段

### Phase 1: HTML (靜態介面)
- 建立獨立的 `snake-static.html`，包含：
  - 遊戲畫布 (canvas)：網格 20x20，每格 20px
  - 蛇身、食物、分數顯示
- 使用純 JS 先驗證邏輯正確性
- 確認無誤後，將靜態 HTML 移植為 Vue SFC (`src/components/SnakeGame.vue`)

### Phase 2: Data (資料層)
在 Vue 元件中建立 `data()` / `ref()` 響應式狀態：
- `snake` — 蛇身座標陣列 `[{x, y}]`
- `food` — 食物座標 `{x, y}`
- `direction` — 當前移動方向
- `score` — 分數
- `gameStatus` — 'idle' | 'playing' | 'gameover'
- 綁定 canvas 渲染邏輯，根據 data 繪圖

### Phase 3: Function (控制與邏輯)
- `startGame()` — 初始化蛇、食物、分數
- `move()` — 每幀移動蛇身
- `changeDirection()` — 鍵盤控制 (WASD / 方向鍵)
- `checkCollision()` — 邊界／自身碰撞偵測
- `generateFood()` — 隨機生成不與蛇重疊的食物
- `eatFood()` — 吃到食物時延長蛇身、加分
- `gameLoop()` — `setInterval` 主循環
- `resetGame()` — 重設遊戲

## 檔案結構
```
hell/vue-project/src/
├── App.vue
├── main.ts
├── components/
│   └── SnakeGame.vue      # 主遊戲元件
└── assets/
    └── ...                 # Vue 預設資源
```
