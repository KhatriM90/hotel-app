import { HttpCloudQueue } from './cloud-client';
import { loadWorkerConfig } from './config';
import { ServiceLayerClient } from './service-layer-client';
import { IntegrationWorker } from './worker';

const config = loadWorkerConfig();
const worker = new IntegrationWorker(
  new HttpCloudQueue(config.cloudApiUrl, config.workerToken, config.workerId),
  new ServiceLayerClient(config.serviceLayer),
  { batchSize: config.batchSize, idlePollMs: config.idlePollMs },
);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => worker.stop());
worker.run().then(() => process.exit(0));
