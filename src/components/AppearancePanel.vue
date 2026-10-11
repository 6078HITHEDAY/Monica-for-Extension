<script setup lang="ts">
import { tr } from '../i18n';
import { paletteId, palettes, setPalette, type ThemePaletteId } from '../lib/theme';

const paletteLabels: Record<ThemePaletteId, string> = { nothing: 'Nothing', monica: 'Monica', get ocean() { return tr('海洋'); }, get forest() { return tr('森林'); }, get sakura() { return tr('樱花'); }, get amber() { return tr('琥珀'); } };
</script>

<template>
  <section class="appearance-page">
        <div class="appearance-controls">
          <section>
            <m3e-radio-group class="palette-list" :aria-label="tr('配色')">
              <label v-choice-label v-for="item in palettes" :key="item.id" class="palette-option" :class="{ selected: item.id === paletteId }">
                <span class="swatch" :style="{ '--swatch': item.color, '--secondary': item.darkColor, '--accent': item.accent }" aria-hidden="true"><span /><span /><span /></span>
                <span class="palette-label">{{ paletteLabels[item.id] }}</span>
                <m3e-radio :value="item.id" :checked.prop="item.id === paletteId" @input="setPalette(item.id)" />
              </label>
            </m3e-radio-group>
          </section>
        </div>
  </section>
</template>

<style scoped>
.appearance-page { min-width: 0; }
.appearance-controls { display: grid; gap: 24px; }
.appearance-controls section { min-width: 0; }
.appearance-controls h3 { margin: 0 0 12px; font-size: .875rem; font-weight: 500; color: var(--md-sys-color-on-surface-variant); }
.palette-list { display: grid; gap: 4px; }
.palette-option { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 56px; padding: 4px 12px; border-radius: 16px; cursor: pointer; }
.palette-option.selected { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.palette-label { overflow-wrap: anywhere; }
.swatch { width: 28px; height: 28px; border-radius: 50%; display: flex; overflow: hidden; }
.swatch > span { flex: 1; height: 100%; }
.swatch > span:first-child { background: var(--swatch); }
.swatch > span:nth-child(2) { background: var(--secondary); }
.swatch > span:last-child { background: var(--accent); }
</style>
