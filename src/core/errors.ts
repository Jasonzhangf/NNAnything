export type WorkflowErrorCode =
  | "LOAD_INVALID_CONFIG"
  | "LOAD_INVALID_GRAPH"
  | "LOAD_PATH_OUTSIDE_ROOT"
  | "LOAD_REMOTE_OR_SCRIPT_GRAPH"
  | "LOAD_UNKNOWN_VERSION"
  | "LOAD_BAD_REFERENCE"
  | "COMPILE_INVALID_GRAPH"
  | "COMPILE_UNKNOWN_OPERATOR"
  | "COMPILE_DUPLICATE_NODE"
  | "COMPILE_DUPLICATE_ARC"
  | "COMPILE_PORT_MISMATCH"
  | "COMPILE_BINDING"
  | "COMPILE_EFFECT_UNAUTHORIZED"
  | "COMPILE_UNSUPPORTED_ITERATOR"
  | "COMPILE_UNSUPPORTED_SELECTOR";

export class WorkflowContractError extends Error {
  readonly code: WorkflowErrorCode;
  readonly nodeId: string | undefined;

  constructor(code: WorkflowErrorCode, message: string, nodeId?: string) {
    super(message);
    this.name = "WorkflowContractError";
    this.code = code;
    this.nodeId = nodeId;
  }
}

export class WorkflowRunError extends Error {
  readonly category: string;
  readonly nodeId: string | undefined;

  constructor(category: string, message: string, nodeId?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowRunError";
    this.category = category;
    this.nodeId = nodeId;
  }
}
