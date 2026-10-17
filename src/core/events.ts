export type EventStatus = "ok" | "skipped" | "filtered_out" | "unknown";

export interface EventProducer {
  readonly nodeId: string;
  readonly port: string;
}

export interface EventCorrelation {
  readonly itemKey?: string;
  readonly nodeRef?: string;
  readonly index?: number;
}

export interface EventEnvelope<TPayload = unknown> {
  readonly runId: string;
  readonly eventId: string;
  readonly producer: EventProducer;
  readonly type: string;
  readonly correlation: EventCorrelation;
  readonly status: EventStatus;
  readonly payload: TPayload;
}

export interface NonOkEventPayload {
  readonly reason: string;
  readonly details?: unknown;
}

export interface EventPort<TPayload = unknown> {
  readonly name: string;
  readonly schemaId: string;
  readonly eventType: string;
  readonly validate: (value: unknown) => TPayload;
}

export type Awaitable<T> = T | Promise<T>;

export interface CreateEventInput<TPayload> {
  readonly runId: string;
  readonly eventId: string;
  readonly producer: EventProducer;
  readonly type: string;
  readonly correlation?: EventCorrelation;
  readonly status?: EventStatus;
  readonly payload: TPayload;
}

export function createEventEnvelope<TPayload>(
  input: CreateEventInput<TPayload>,
): EventEnvelope<TPayload> {
  return {
    runId: input.runId,
    eventId: input.eventId,
    producer: {
      nodeId: input.producer.nodeId,
      port: input.producer.port,
    },
    type: input.type,
    correlation: { ...input.correlation },
    status: input.status ?? "ok",
    payload: input.payload,
  };
}

export const WORKFLOW_INPUT_NODE_ID = "$workflow-input";

export function createWorkflowInputEvent<TPayload>(
  input: Omit<CreateEventInput<TPayload>, "producer"> & { readonly port: string },
): EventEnvelope<TPayload> {
  return createEventEnvelope({
    runId: input.runId,
    eventId: input.eventId,
    producer: {
      nodeId: WORKFLOW_INPUT_NODE_ID,
      port: input.port,
    },
    type: input.type,
    ...(input.correlation === undefined ? {} : { correlation: input.correlation }),
    ...(input.status === undefined ? {} : { status: input.status }),
    payload: input.payload,
  });
}
