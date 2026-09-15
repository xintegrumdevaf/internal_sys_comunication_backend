import { createContainer } from "./core/composition/container";
// Composition Root Entrypoint - ISP Omnichannel Backend System
import { startServer } from "./core/http/server";

// Auto-reloaded container with campaign delivery status sync
const container = createContainer();
startServer(container);
