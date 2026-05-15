<script setup lang="ts">
// Root component — mounts the SnakeGame
import SnakeGame from './components/SnakeGame.vue'
</script>

<template>
  <div class="app">
    <SnakeGame />
  </div>
</template>

<style>
/* Global reset & page-level centering */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
body {
  background: #0f0f23;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  font-family: 'Segoe UI', sans-serif;
}
</style>
