<template>
  <div class="settings-entry-list"><slot /></div>
</template>

<style scoped>
.settings-entry-list { display: grid; gap: 4px; }
.settings-entry-list > :deep(*) { min-width: 0; margin: 0; padding: 8px 16px; box-sizing: border-box; border-radius: 4px; color: var(--md-sys-color-on-surface); background: var(--md-sys-color-surface-container-low); }
.settings-entry-list > :deep(:first-child) { border-top-left-radius: 24px; border-top-right-radius: 24px; }
.settings-entry-list > :deep(:last-child) { border-bottom-left-radius: 24px; border-bottom-right-radius: 24px; }
.settings-entry-list :deep(.settings-nav-entry) { display: grid; grid-template-columns: 40px minmax(0, 1fr) 24px; align-items: center; gap: 16px; width: 100%; min-height: 72px; border: 0; font: inherit; text-align: start; cursor: pointer; }
.settings-entry-list :deep(.settings-nav-entry:disabled) { cursor: default; opacity: .6; }
.settings-entry-list :deep(.settings-control) { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 16px; align-items: center; }
.settings-entry-list :deep(.settings-control > :last-child) { min-width: 0; width: 100%; }
.settings-entry-list :deep(.settings-control-icon) { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); }
.settings-entry-list :deep(.settings-control m3e-form-field) { --m3e-form-field-container-color: transparent; }
.settings-entry-list :deep(.settings-control:has([data-settings-select]):hover),
.settings-entry-list :deep(.settings-control:has([data-settings-select] [aria-expanded="true"])) { background: var(--md-sys-color-surface-container-high); }
/* One keyboard indicator follows the grouped row's corners, never an inner
   pill. Scope the reset to the select so menu options keep their own focus. */
.settings-entry-list :deep(.settings-control [data-settings-select] :is(m3e-select, select)) { --m3e-focus-ring-visibility: hidden; outline: none; }
.settings-entry-list :deep(.settings-control:has([data-settings-select]:not([data-pointer-focus]) :focus-visible)) { outline: 2px solid var(--md-sys-color-primary); outline-offset: -2px; }
@media (forced-colors: active) {
  .settings-entry-list :deep(.settings-control:has([data-settings-select]:not([data-pointer-focus]) :focus-visible)) { outline-color: Highlight; }
}
.settings-entry-list :deep(.settings-nav-entry:hover) { background: var(--md-sys-color-surface-container-high); }
.settings-entry-list :deep(.settings-nav-entry:active) { background: var(--md-sys-color-secondary-container); }
.settings-entry-list :deep(.settings-nav-entry:focus-visible) { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
.settings-entry-list :deep(.settings-nav-icon) { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); }
.settings-entry-list :deep(.settings-nav-icon m3e-icon), .settings-entry-list :deep(.settings-nav-chevron) { --m3e-icon-size: 24px; }
.settings-entry-list :deep(.settings-nav-chevron) { color: var(--md-sys-color-on-surface-variant); }
.settings-entry-list :deep(.settings-nav-copy) { display: grid; gap: 4px; min-width: 0; }
.settings-entry-list :deep(.settings-nav-copy strong) { font-size: 1rem; line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }
.settings-entry-list :deep(.settings-nav-copy small) { font-size: .875rem; line-height: 1.5; color: var(--md-sys-color-on-surface-variant); overflow-wrap: anywhere; }

@media (max-width: 480px) {
  .settings-entry-list :deep(.settings-nav-entry) { gap: 12px; }
  .settings-entry-list :deep(.settings-control) { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .settings-entry-list :deep(.settings-control-icon) { display: none; }
}
</style>
