import { handleFetch } from "./src/worker/fetch";
import { scheduled } from "./src/worker/scheduled";
import type { WorkerEnv } from "./src/worker/env";
export { CollectorObject } from "./src/worker/collector-object";
export default { fetch:handleFetch, scheduled } satisfies ExportedHandler<WorkerEnv>;
