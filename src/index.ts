import { createContainer } from "./core/composition/container";
import { startServer } from "./core/http/server";

const container = createContainer();
startServer(container);
