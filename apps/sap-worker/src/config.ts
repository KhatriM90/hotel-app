export interface WorkerConfig {
  /** Cloud API base, e.g. https://dev.hotel.example/api (outbound HTTPS from HQ only). */
  cloudApiUrl: string;
  workerToken: string;
  workerId: string;
  batchSize: number;
  idlePollMs: number;
  serviceLayer: {
    /** e.g. https://sap-hq.local:50000/b1s/v2 — stays on the HQ LAN. */
    baseUrl: string;
    companyDb: string;
    username: string;
    password: string;
    timeoutMs: number;
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const workerToken = required(env, 'WORKER_TOKEN');
  if (workerToken.length < 32) throw new Error('WORKER_TOKEN must be at least 32 characters');
  return {
    cloudApiUrl: required(env, 'CLOUD_API_URL').replace(/\/$/, ''),
    workerToken,
    workerId: env.WORKER_ID ?? 'hq-worker-1',
    batchSize: Number(env.WORKER_BATCH_SIZE ?? 10),
    idlePollMs: Number(env.WORKER_IDLE_POLL_MS ?? 5000),
    serviceLayer: {
      baseUrl: required(env, 'SL_BASE_URL').replace(/\/$/, ''),
      companyDb: required(env, 'SL_COMPANY_DB'),
      username: required(env, 'SL_USERNAME'),
      password: required(env, 'SL_PASSWORD'),
      timeoutMs: Number(env.SL_TIMEOUT_MS ?? 30000),
    },
  };
}
