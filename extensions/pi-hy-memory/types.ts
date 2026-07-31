export const HY_MEMORY_CONFIG_SCHEMA = "pi67-hy-memory-config/v1";
export const HY_MEMORY_SECRETS_SCHEMA = "pi67-hy-memory-secrets/v1";
export const HY_MEMORY_LEGACY_RUNTIME_SCHEMA = "pi67-hy-memory-runtime/v1";
export const HY_MEMORY_RUNTIME_SCHEMA = "pi67-hy-memory-runtime/v2";
export const HY_MEMORY_SERVICE_SCHEMA = "pi67-hy-memory-service/v1";
export const HY_MEMORY_OUTBOX_SCHEMA = "pi67-hy-memory-outbox/v1";
export const HY_MEMORY_OPERATION_SCHEMA = "pi67-hy-memory-operation/v1";

export type KeySource = {
  type: "pi-auth";
  provider: string;
};

export type HyMemoryConfig = {
  schema: typeof HY_MEMORY_CONFIG_SCHEMA;
  enabled: boolean;
  mode: "pro";
  userId: string;
  agentId: string;
  llm: {
    provider: "openai";
    baseUrl: string;
    model: string;
    keySource: KeySource;
  };
  embedder: {
    provider: "openai";
    baseUrl: string;
    model: string;
    requestDimensions: null;
    vectorDimensions: number;
  };
  recall: {
    topK: number;
    minScore: number;
    profileLimit: number;
    profileMinScore: number;
    intentionLimit: number;
    timeoutMs: number;
    maxChars: number;
  };
  capture: {
    maxMessageChars: number;
    batchTurns: number;
    maxDelayMs: number;
    maxAttempts: number;
  };
};

export type HyMemorySecrets = {
  schema: typeof HY_MEMORY_SECRETS_SCHEMA;
  embeddingApiKey: string;
  serviceBearerToken: string;
  llmApiKey?: string;
};

type HyMemoryRuntimeBase = {
  sdkVersion: string;
  python: string;
  serviceScript: string;
  wrapperSha256?: string;
  wheelSha256: string;
  installedAt: string;
};

export type HyMemoryLegacyRuntime = HyMemoryRuntimeBase & {
  schema: typeof HY_MEMORY_LEGACY_RUNTIME_SCHEMA;
};

export type HyMemoryLockedRuntime = HyMemoryRuntimeBase & {
  schema: typeof HY_MEMORY_RUNTIME_SCHEMA;
  dependencyLockId: string;
  dependencyLockTarget: string;
  dependencyLockSha256: string;
  pythonRuntimeManifest: string;
  pythonRuntimeManifestSha256: string;
};

export type HyMemoryRuntime = HyMemoryLegacyRuntime | HyMemoryLockedRuntime;

export type HyMemoryServiceRecord = {
  schema: typeof HY_MEMORY_SERVICE_SCHEMA;
  pid: number;
  port: number;
  instanceId: string;
  root: string;
  dataDir: string;
  sdkVersion: string;
  startedAt: string;
};

export type CaptureMessage = {
  role: "user" | "assistant";
  content: string;
};

export type OutboxJob = {
  schema: typeof HY_MEMORY_OUTBOX_SCHEMA;
  requestId: string;
  userId: string;
  agentId: string;
  sessionId: string;
  leafId: string;
  messages: CaptureMessage[];
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  operationId?: string;
  operationState?: HyMemoryOperationState;
  operationStatusPath?: string;
  resolutionRequired?: boolean;
};

export type HyMemoryOperationState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

export type HyMemoryOperationReceipt = {
  schema: typeof HY_MEMORY_OPERATION_SCHEMA;
  operationId: string;
  kind: "probe" | "search" | "capture" | "list" | "get" | "forget" | "digest";
  state: HyMemoryOperationState;
  mutating: boolean;
  retryable: boolean;
  statusPath: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: Record<string, unknown>;
  resultAvailable?: boolean;
  error?: { code: string };
};

export type HyMemoryPaths = {
  root: string;
  configFile: string;
  secretsFile: string;
  dataDir: string;
  outboxDir: string;
  pendingDir: string;
  processingDir: string;
  deadLetterDir: string;
  runtimeDir: string;
  runtimeFile: string;
  serviceFile: string;
  startLockFile: string;
  lifetimeLockFile: string;
  lifetimeOwnerFile: string;
  outboxAdmissionLockDir: string;
  logsDir: string;
};

export type ServiceInfo = {
  schema: typeof HY_MEMORY_SERVICE_SCHEMA;
  instanceId: string;
  pid: number;
  root: string;
  dataDir: string;
  sdkVersion: string;
  mode: string;
  vectorDimensions: number;
  storagePolicy: {
    codingMemoryEnabled: boolean;
    historyAuditEnabled: boolean;
    memoryOperationsEnabled: boolean;
    pipelineDbTraceEnabled: boolean;
    legacyRequestTraceEnabled: boolean;
    pipelineJsonlEnabled: boolean;
    pipelineJsonlControl: "sdk-1.2.20-always-on";
    fullPurgeSupported: boolean;
  };
  outbox: {
    pending: number;
    processing: number;
    deadLetter: number;
    unresolved?: number;
    activeBytes?: number;
    deadLetterBytes?: number;
    saturated?: boolean;
    limits?: {
      maxActiveJobs: number;
      maxActiveBytes: number;
      maxDeadLetterJobs: number;
      maxDeadLetterBytes: number;
      deadLetterRetentionMs: number;
    };
  };
  operations?: {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    unknown: number;
    corrupt: number;
  };
};
