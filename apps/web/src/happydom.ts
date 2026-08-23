// Preloaded before every test in apps/web (see bunfig.toml). Bun has no
// built-in DOM, this registers happy-dom globally so React components can
// render under `bun test`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A url is required, not optional: happy-dom otherwise starts at about:blank,
// where history.replaceState(null, "", "/some/path") silently leaves
// location.pathname as "blank" instead of the path. The client side router in
// src/router.tsx reads location.pathname, so every routing test would resolve
// to the same bogus path without this.
GlobalRegistrator.register({ url: "http://localhost:3000/" });
