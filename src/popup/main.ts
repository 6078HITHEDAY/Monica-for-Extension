import { createApp } from "vue";
import PopupApp from "./PopupApp.vue";
import "../styles.css";
import "./popup.css";
import "../responsive.css";
import "../material.css";
import "../nothing.css";
import "../lib/action-button-layout";
import "../lib/list-item-layout";
import { installMaterialControls } from "../lib/material-controls";
import { initializeI18n } from "../i18n";
import { isFirefoxExtension } from "../runtime/browser-platform";

// Action popups size their viewport from the document. Give that surface an
// intrinsic width before mounting; standalone tabs can still follow their viewport.
const listedAsPopup = globalThis.chrome?.extension?.getViews?.({ type: "popup" }).includes(window);
let actionPopupClassReady: Promise<void> = Promise.resolve();
if (listedAsPopup) {
  document.documentElement.classList.add("action-popup");
} else if (!isFirefoxExtension()) {
  // shortcut: getViews({type:'popup'}) omits the popup itself on Vivaldi (VB-126004); on Chromium tabs.getCurrent delivers a tab only in standalone pages. Drop when Vivaldi fixes getViews.
  actionPopupClassReady = new Promise((resolve) => {
    const tabs = globalThis.chrome?.tabs;
    if (!tabs?.getCurrent) { resolve(); return; }
    tabs.getCurrent((tab?: chrome.tabs.Tab) => {
      if (!tab) document.documentElement.classList.add("action-popup");
      resolve();
    });
  });
}

void initializeI18n().then(() => actionPopupClassReady).then(() => createApp(PopupApp).use(installMaterialControls).mount("#popup-root"));
