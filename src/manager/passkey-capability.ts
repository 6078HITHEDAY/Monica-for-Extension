import { createPasskeyKeyInspector } from '../passkey/capability';

// Only manager views import this instance. Cleared when the vault locks or the view closes.
export const managerPasskeyInspector = createPasskeyKeyInspector();
