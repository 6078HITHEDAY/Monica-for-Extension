import { ResizeController } from "@m3e/web/core";
import { M3eListItemElement } from "@m3e/web/list";

// Install before Vue mounts either extension page. After each render, M3E's
// ResizeController measures a list item's line count synchronously (computed
// style + scrollHeight). When a page renders many items in one batch, every
// item writes DOM and then forces a full layout: 50 OTP tiles froze the manager
// for seconds. Run those measurements together in one animation frame instead.
// The reads are unchanged and the library already defers its state writes.
const pending = new Map<ResizeController, () => void>();
let frame = 0;

function flush(): void {
  frame = 0;
  const batch = [...pending.values()];
  pending.clear();
  for (const measure of batch) measure();
}

type Controller = Parameters<M3eListItemElement["addController"]>[0];
const addController = M3eListItemElement.prototype.addController;
M3eListItemElement.prototype.addController = function (this: M3eListItemElement, controller: Controller) {
  if (controller instanceof ResizeController) {
    const hostUpdated = controller.hostUpdated.bind(controller);
    controller.hostUpdated = async () => {
      pending.set(controller, () => { if (this.isConnected) void hostUpdated(); });
      frame ||= requestAnimationFrame(flush);
    };
  }
  addController.call(this, controller);
};
