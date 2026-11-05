import { handleFetch } from "./src/worker/fetch";
import { scheduled } from "./src/worker/scheduled";
import type { WorkerEnv } from "./src/worker/env";
export default { fetch:handleFetch, scheduled } satisfies ExportedHandler<WorkerEnv>;
